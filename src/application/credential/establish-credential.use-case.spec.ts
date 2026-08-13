import { InMemoryAuthenticatorUnitOfWork } from '../../adapters/persistence/in-memory/in-memory-authenticator-unit-of-work';
import { InMemoryApiKeyStore } from '../../adapters/persistence/in-memory/in-memory-api-key-store';
import { Argon2PasswordHasher } from '../../adapters/crypto/argon2-password-hasher';
import { RandomSecretGenerator } from '../../adapters/crypto/random-secret-generator';
import {
  createIdentityTestContext,
  TEST_MOMENT,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { signInId } from '../../domain/identifiers';
import {
  secretDigest,
  type OpaqueSecret,
} from '../../domain/credential/secrets';
import { IssueSetupTokenUseCase } from './issue-setup-token.use-case';
import { RedeemSetupTokenUseCase } from './redeem-setup-token.use-case';

const PASSWORD = 'correct horse battery staple';

describe('establishing a credential', () => {
  let context: IdentityTestContext;
  let authenticator: InMemoryAuthenticatorUnitOfWork;
  let issue: IssueSetupTokenUseCase;
  let redeem: RedeemSetupTokenUseCase;
  let secrets: RandomSecretGenerator;

  beforeEach(() => {
    context = createIdentityTestContext();
    authenticator = new InMemoryAuthenticatorUnitOfWork(
      context.credentials,
      new InMemoryApiKeyStore(),
    );
    secrets = new RandomSecretGenerator();
    const hasher = new Argon2PasswordHasher({
      memoryCostKiB: 8192,
      timeCost: 1,
      parallelism: 1,
    });

    issue = new IssueSetupTokenUseCase(
      context.platform,
      secrets,
      context.clock,
      context.identifiers,
    );
    redeem = new RedeemSetupTokenUseCase(
      authenticator,
      hasher,
      context.clock,
      secrets,
    );
  });

  async function aPerson(email = 'member@example.com'): Promise<string> {
    const tenantId = await context.seedTenant('Acme');
    return context.seedMember({ tenantId, email, role: 'viewer' });
  }

  describe('issuing', () => {
    it('returns a token once and stores only its digest', async () => {
      const person = await aPerson();

      const token = await issue.execute({
        actor: context.operator,
        personId: person,
      });

      expect(token).toEqual(expect.any(String));
      const stored = [...context.credentials.setupTokens.values()];
      expect(stored).toHaveLength(1);
      expect(stored[0].secretDigest).toBe(secrets.digest(token));
      expect(JSON.stringify(stored)).not.toContain(token);
    });

    it('gives the token a bounded life', async () => {
      const person = await aPerson();

      await issue.execute({ actor: context.operator, personId: person });

      const [stored] = [...context.credentials.setupTokens.values()];
      const hours =
        (stored.expiresAt.getTime() - TEST_MOMENT.getTime()) / 3_600_000;
      expect(hours).toBeGreaterThan(0);
      expect(hours).toBeLessThanOrEqual(24);
    });

    it('denies issuance to anyone who is not a platform operator', async () => {
      const person = await aPerson();
      const tenant = [...context.store.tenants.values()][0];

      const attempt = issue.execute({
        actor: context.actingAs(tenant.id, person),
        personId: person,
      });

      await expect(attempt).rejects.toMatchObject({
        error: { kind: 'forbidden' },
      });
      expect(context.credentials.setupTokens.size).toBe(0);
    });
  });

  describe('redeeming', () => {
    async function issuedFor(person: string): Promise<OpaqueSecret> {
      return issue.execute({ actor: context.operator, personId: person });
    }

    it('establishes the password the holder chose', async () => {
      const person = await aPerson();
      const token = await issuedFor(person);

      await redeem.execute({ token, password: PASSWORD });

      const stored = context.credentials.passwords.get(person);
      expect(stored).toBeDefined();
      expect(stored?.digest).not.toContain(PASSWORD);
    });

    it('retires the token, so it works exactly once', async () => {
      const person = await aPerson();
      const token = await issuedFor(person);

      await redeem.execute({ token, password: PASSWORD });
      const second = redeem.execute({
        token,
        password: 'a different password',
      });

      await expect(second).rejects.toMatchObject({
        error: { kind: 'not-found' },
      });
    });

    /** Requirement 1.3: one response for three different reasons. */
    it('answers identically for redeemed, expired and invented tokens', async () => {
      const person = await aPerson();
      const redeemed = await issuedFor(person);
      await redeem.execute({ token: redeemed, password: PASSWORD });

      const expired = await issuedFor(person);
      context.clock.advanceTo(new Date(TEST_MOMENT.getTime() + 25 * 3_600_000));

      const outcomes = await Promise.all(
        [redeemed, expired, secrets.generate()].map((token) =>
          redeem
            .execute({ token, password: PASSWORD })
            .then(() => 'accepted')
            .catch((error: { error: unknown }) => JSON.stringify(error.error)),
        ),
      );

      expect(new Set(outcomes).size).toBe(1);
      expect(outcomes[0]).toContain('not-found');
    });

    it('rejects a password shorter than the rule allows, leaving the token usable', async () => {
      const person = await aPerson();
      const token = await issuedFor(person);

      await expect(
        redeem.execute({ token, password: 'short' }),
      ).rejects.toMatchObject({
        error: { kind: 'validation', field: 'password' },
      });

      // The token survives a rejected attempt: the holder mistyped, they did not
      // burn their one chance.
      await expect(
        redeem.execute({ token, password: PASSWORD }),
      ).resolves.toBeUndefined();
    });

    /** Requirement 1.5, and the mitigation for an operator seizing an account. */
    it('ends every session the person holds', async () => {
      const person = await aPerson();
      await authenticator.runAuthenticating(({ sessions }) =>
        sessions.insert({
          id: 'existing-token',
          signInId: signInId('earlier-sign-in'),
          personId: person,
          secretDigest: secretDigest('an-earlier-digest'),
          sessionExpiresAt: new Date(TEST_MOMENT.getTime() + 86_400_000),
        }),
      );
      const token = await issuedFor(person);

      await redeem.execute({ token, password: PASSWORD });

      expect(
        context.credentials.refreshTokens.get('existing-token')?.invalidatedAt,
      ).toEqual(TEST_MOMENT);
    });
  });
});
