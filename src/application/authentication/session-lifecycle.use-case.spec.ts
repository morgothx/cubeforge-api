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
import type { OpaqueSecret } from '../../domain/credential/secrets';
import { personId } from '../../domain/identifiers';
import { deactivatePerson } from '../../domain/person/person.entity';
import { RefreshSessionUseCase } from './refresh-session.use-case';
import { SignInUseCase } from './sign-in.use-case';
import { SignOutUseCase } from './sign-out.use-case';

const PASSWORD = 'correct horse battery staple';

describe('the session lifecycle', () => {
  let context: IdentityTestContext;
  let signIn: SignInUseCase;
  let refresh: RefreshSessionUseCase;
  let signOut: SignOutUseCase;
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
    const authenticator = new InMemoryAuthenticatorUnitOfWork(
      context.credentials,
      new InMemoryApiKeyStore(),
    );
    const tokens = new JwtAccessTokenIssuer({
      secret: 'a-signing-secret-long-enough-for-the-rule',
      accessTokenLifetimeSeconds: 900,
    });

    signIn = new SignInUseCase(
      authenticator,
      hasher,
      tokens,
      secrets,
      context.clock,
      context.identifiers,
    );
    refresh = new RefreshSessionUseCase(
      authenticator,
      tokens,
      secrets,
      context.clock,
      context.identifiers,
    );
    signOut = new SignOutUseCase(authenticator, secrets, context.clock);
  });

  let tenants = 0;

  async function aSignedInPerson(
    email = 'member@example.com',
  ): Promise<{ person: string; refreshToken: OpaqueSecret }> {
    const tenantId = await context.seedTenant(`Tenant ${(tenants += 1)}`);
    const person = await context.seedMember({
      tenantId,
      email,
      role: 'viewer',
    });
    context.credentials.passwords.set(person, {
      digest: await hasher.hash(PASSWORD),
      updatedAt: TEST_MOMENT,
    });
    const session = await signIn.execute({ email, password: PASSWORD });
    return { person, refreshToken: session.refreshToken };
  }

  describe('refreshing', () => {
    it('issues a new pair and retires the one presented', async () => {
      const { refreshToken } = await aSignedInPerson();

      const next = await refresh.execute({ refreshToken });

      expect(next.refreshToken).not.toBe(refreshToken);
      const retired = [...context.credentials.refreshTokens.values()].find(
        (token) => token.secretDigest === secrets.digest(refreshToken),
      );
      expect(retired?.exchangedAt).toEqual(TEST_MOMENT);
    });

    it('continues the session without extending it', async () => {
      const { refreshToken } = await aSignedInPerson();
      const deadline =
        TEST_MOMENT.getTime() + SESSION_LIFETIME_DAYS * 86_400_000;
      context.clock.advanceTo(new Date(TEST_MOMENT.getTime() + 86_400_000));

      const next = await refresh.execute({ refreshToken });

      // Rotating must not push the deadline out, or a session used daily would
      // never end.
      expect(next.sessionExpiresAt.getTime()).toBe(deadline);
    });

    /** Requirement 4.2, the reason refresh tokens carry a family. */
    it('ends the whole family when a token is presented twice', async () => {
      const { refreshToken } = await aSignedInPerson();
      const second = await refresh.execute({ refreshToken });

      await expect(refresh.execute({ refreshToken })).rejects.toMatchObject({
        error: { kind: 'not-found' },
      });

      // The successor, held by the legitimate user, is dead too.
      await expect(
        refresh.execute({ refreshToken: second.refreshToken }),
      ).rejects.toMatchObject({ error: { kind: 'not-found' } });
    });

    it('refuses a token past the session deadline', async () => {
      const { refreshToken } = await aSignedInPerson();
      context.clock.advanceTo(
        new Date(
          TEST_MOMENT.getTime() + (SESSION_LIFETIME_DAYS + 1) * 86_400_000,
        ),
      );

      await expect(refresh.execute({ refreshToken })).rejects.toMatchObject({
        error: { kind: 'not-found' },
      });
    });

    it('answers expired, invalidated and unrecognized tokens identically', async () => {
      const expired = await aSignedInPerson('expired@example.com');
      const invalidated = await aSignedInPerson('invalidated@example.com');
      await signOut.execute({
        refreshToken: invalidated.refreshToken,
        everywhere: false,
      });
      context.clock.advanceTo(
        new Date(
          TEST_MOMENT.getTime() + (SESSION_LIFETIME_DAYS + 1) * 86_400_000,
        ),
      );

      const outcomes = await Promise.all(
        [
          expired.refreshToken,
          invalidated.refreshToken,
          secrets.generate(),
        ].map((refreshToken) =>
          refresh
            .execute({ refreshToken })
            .then(() => 'accepted')
            .catch((error: { error: unknown }) => JSON.stringify(error.error)),
        ),
      );

      expect(new Set(outcomes).size).toBe(1);
    });

    /** Requirement 6.1 and 6.2: deactivation ends access, not just issuance. */
    it('refuses a deactivated person and ends their sessions', async () => {
      const { person, refreshToken } = await aSignedInPerson();
      const stored = context.store.people.get(personId(person));
      context.store.people.set(personId(person), deactivatePerson(stored!));

      await expect(refresh.execute({ refreshToken })).rejects.toMatchObject({
        error: { kind: 'not-found' },
      });
      expect(
        [...context.credentials.refreshTokens.values()].every(
          (token) => token.invalidatedAt !== null,
        ),
      ).toBe(true);
    });
  });

  describe('signing out', () => {
    it('ends this session and leaves the person other sessions', async () => {
      const { person, refreshToken } = await aSignedInPerson();
      const other = await signIn.execute({
        email: 'member@example.com',
        password: PASSWORD,
      });

      await signOut.execute({ refreshToken, everywhere: false });

      await expect(refresh.execute({ refreshToken })).rejects.toBeDefined();
      await expect(
        refresh.execute({ refreshToken: other.refreshToken }),
      ).resolves.toBeDefined();
      expect(person).toBeDefined();
    });

    it('ends every session when asked for everywhere', async () => {
      const { refreshToken } = await aSignedInPerson();
      const other = await signIn.execute({
        email: 'member@example.com',
        password: PASSWORD,
      });

      await signOut.execute({ refreshToken, everywhere: true });

      for (const token of [refreshToken, other.refreshToken]) {
        await expect(
          refresh.execute({ refreshToken: token }),
        ).rejects.toMatchObject({ error: { kind: 'not-found' } });
      }
    });

    it('succeeds silently for a token it does not recognize', async () => {
      await expect(
        signOut.execute({ refreshToken: secrets.generate(), everywhere: true }),
      ).resolves.toBeUndefined();
    });
  });
});
