import { Argon2PasswordHasher } from '../../adapters/crypto/argon2-password-hasher';
import { JwtAccessTokenIssuer } from '../../adapters/crypto/access-token-issuer';
import { RandomSecretGenerator } from '../../adapters/crypto/random-secret-generator';
import { InMemoryApiKeyStore } from '../../adapters/persistence/in-memory/in-memory-api-key-store';
import { InMemoryAuthenticatorUnitOfWork } from '../../adapters/persistence/in-memory/in-memory-authenticator-unit-of-work';
import {
  createIdentityTestContext,
  TEST_MOMENT,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { SESSION_LIFETIME_DAYS } from '../../domain/credential/session';
import {
  emailAddress,
  personId,
  type PersonId,
} from '../../domain/identifiers';
import { createPerson } from '../../domain/person/person.entity';
import { SignInUseCase } from './sign-in.use-case';

const PASSWORD = 'correct horse battery staple';

describe('signing in', () => {
  let context: IdentityTestContext;
  let signIn: SignInUseCase;
  let hasher: Argon2PasswordHasher;
  let secrets: RandomSecretGenerator;

  beforeEach(() => {
    context = createIdentityTestContext();
    hasher = new Argon2PasswordHasher({
      memoryCostKiB: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    secrets = new RandomSecretGenerator();
    signIn = new SignInUseCase(
      new InMemoryAuthenticatorUnitOfWork(
        context.credentials,
        new InMemoryApiKeyStore(),
        context.store,
      ),
      hasher,
      new JwtAccessTokenIssuer({
        secret: 'a-signing-secret-long-enough-for-the-rule',
        accessTokenLifetimeSeconds: 900,
      }),
      secrets,
      context.clock,
      context.identifiers,
    );
  });

  let tenantCount = 0;

  /** A fresh tenant per call: tenant names are unique platform-wide. */
  async function aMemberWithPassword(
    email = 'member@example.com',
  ): Promise<PersonId> {
    const tenantId = await context.seedTenant(`Tenant ${(tenantCount += 1)}`);
    const person = await context.seedMember({
      tenantId,
      email,
      role: 'viewer',
    });
    context.credentials.passwords.set(person, {
      digest: await hasher.hash(PASSWORD),
      updatedAt: TEST_MOMENT,
    });
    return person;
  }

  it('issues a session for the right password', async () => {
    const person = await aMemberWithPassword();

    const session = await signIn.execute({
      email: 'member@example.com',
      password: PASSWORD,
    });

    expect(session.accessToken.split('.')).toHaveLength(3);
    expect(typeof session.refreshToken).toBe('string');
    expect(session.sessionExpiresAt.getTime()).toBe(
      TEST_MOMENT.getTime() + SESSION_LIFETIME_DAYS * 86_400_000,
    );
    const [stored] = [...context.credentials.refreshTokens.values()];
    expect(stored.personId).toBe(person);
    expect(stored.secretDigest).toBe(secrets.digest(session.refreshToken));
  });

  it('stores only the digest of the refresh token', async () => {
    await aMemberWithPassword();

    const session = await signIn.execute({
      email: 'member@example.com',
      password: PASSWORD,
    });

    expect(
      JSON.stringify([...context.credentials.refreshTokens.values()]),
    ).not.toContain(session.refreshToken);
  });

  /** Requirement 2.2 and 2.3: four different facts, one response. */
  it('rejects unknown, credential-less, deactivated and wrong identically', async () => {
    await aMemberWithPassword('member@example.com');
    const tenantId = [...context.store.tenants.values()][0].id;
    await context.seedMember({
      tenantId,
      email: 'nopassword@example.com',
      role: 'viewer',
    });
    const deactivated = await aMemberWithPassword('gone@example.com');
    context.store.people.set(deactivated, {
      ...context.store.people.get(personId(deactivated))!,
      status: 'deactivated',
    });

    const attempts = [
      { email: 'stranger@example.com', password: PASSWORD },
      { email: 'nopassword@example.com', password: PASSWORD },
      { email: 'gone@example.com', password: PASSWORD },
      { email: 'member@example.com', password: 'the wrong password entirely' },
      { email: 'not-even-an-address', password: PASSWORD },
    ];

    const outcomes = await Promise.all(
      attempts.map((attempt) =>
        signIn
          .execute(attempt)
          .then(() => 'accepted')
          .catch((error: { error: unknown }) => JSON.stringify(error.error)),
      ),
    );

    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toContain('not-found');
    expect(context.credentials.refreshTokens.size).toBe(0);
  });

  /**
   * Requirement 2.4. Holding no membership says nothing about who someone is,
   * and refusing here would make the response differ by membership.
   */
  it('issues a session to someone who belongs to no tenant', async () => {
    const person = personId('unattached-person');
    context.store.people.set(
      person,
      createPerson({
        id: person,
        email: emailAddress('unattached@example.com'),
        createdAt: TEST_MOMENT,
      }),
    );
    context.credentials.passwords.set(person, {
      digest: await hasher.hash(PASSWORD),
      updatedAt: TEST_MOMENT,
    });

    const session = await signIn.execute({
      email: 'unattached@example.com',
      password: PASSWORD,
    });

    expect(typeof session.refreshToken).toBe('string');
  });

  it('starts a distinct sign-in each time, so sessions end independently', async () => {
    await aMemberWithPassword();

    await signIn.execute({ email: 'member@example.com', password: PASSWORD });
    await signIn.execute({ email: 'member@example.com', password: PASSWORD });

    const families = new Set(
      [...context.credentials.refreshTokens.values()].map(
        (token) => token.signInId,
      ),
    );
    expect(families.size).toBe(2);
  });
});
