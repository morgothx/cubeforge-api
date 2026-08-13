import {
  opaqueSecret,
  passwordDigest,
  secretDigest,
} from '../../../domain/credential/secrets';
import {
  apiKeyId,
  emailAddress,
  personId,
  signInId,
  tenantId,
} from '../../../domain/identifiers';
import { InMemoryApiKeyStore } from './in-memory-api-key-store';
import { InMemoryAuthenticatorUnitOfWork } from './in-memory-authenticator-unit-of-work';
import { InMemoryCredentialStore } from './in-memory-credential-store';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');

describe('the in-memory authenticating adapters', () => {
  const person = personId('person-1');
  const acme = tenantId('acme');
  const globex = tenantId('globex');

  let store: InMemoryCredentialStore;
  let keys: InMemoryApiKeyStore;
  let unitOfWork: InMemoryAuthenticatorUnitOfWork;

  beforeEach(() => {
    const known = { id: person, status: 'active' as const };
    store = new InMemoryCredentialStore({
      byEmail: (email) =>
        email === emailAddress('member@example.com') ? known : null,
      byId: (id) => (id === person ? known : null),
    });
    keys = new InMemoryApiKeyStore();
    unitOfWork = new InMemoryAuthenticatorUnitOfWork(store, keys);
  });

  describe('credentials', () => {
    it('reports a person who exists without a password', async () => {
      const found = await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.findByEmail(emailAddress('member@example.com')),
      );

      // The distinction the shape forces a caller to consider: the person is
      // real, and still cannot sign in.
      expect(found).toEqual({
        personId: person,
        personStatus: 'active',
        passwordDigest: null,
      });
    });

    it('reports nothing for an address the platform does not know', async () => {
      await expect(
        unitOfWork.runAuthenticating(({ credentials }) =>
          credentials.findByEmail(emailAddress('stranger@example.com')),
        ),
      ).resolves.toBeNull();
    });

    it('replaces an existing password rather than refusing', async () => {
      await unitOfWork.runAuthenticating(async ({ credentials }) => {
        await credentials.establishPassword(
          person,
          passwordDigest('first'),
          NOW,
        );
        await credentials.establishPassword(
          person,
          passwordDigest('second'),
          LATER,
        );
      });

      expect(store.passwords.get(person)).toEqual({
        digest: 'second',
        updatedAt: LATER,
      });
    });

    it('finds a setup token by digest and retires it once', async () => {
      store.setupTokens.set('token-1', {
        id: 'token-1',
        personId: person,
        secretDigest: secretDigest('digest-1'),
        expiresAt: LATER,
        redeemedAt: null,
      });

      const before = await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.findSetupToken(secretDigest('digest-1')),
      );
      await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.markSetupTokenRedeemed('token-1', NOW),
      );
      const after = await unitOfWork.runAuthenticating(({ credentials }) =>
        credentials.findSetupToken(secretDigest('digest-1')),
      );

      expect(before?.redeemedAt).toBeNull();
      expect(after?.redeemedAt).toEqual(NOW);
    });
  });

  describe('sessions', () => {
    async function insertToken(
      id: string,
      sign: string,
      digest: string,
    ): Promise<void> {
      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.insert({
          id,
          signInId: signInId(sign),
          personId: person,
          secretDigest: secretDigest(digest),
          sessionExpiresAt: LATER,
        }),
      );
    }

    it('ends every token of one sign-in and leaves other sign-ins alone', async () => {
      await insertToken('a1', 'sign-in-a', 'digest-a1');
      await insertToken('a2', 'sign-in-a', 'digest-a2');
      await insertToken('b1', 'sign-in-b', 'digest-b1');

      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.invalidateFamily(signInId('sign-in-a'), NOW),
      );

      expect(store.refreshTokens.get('a1')?.invalidatedAt).toEqual(NOW);
      expect(store.refreshTokens.get('a2')?.invalidatedAt).toEqual(NOW);
      expect(store.refreshTokens.get('b1')?.invalidatedAt).toBeNull();
    });

    it('ends every session a person holds', async () => {
      await insertToken('a1', 'sign-in-a', 'digest-a1');
      await insertToken('b1', 'sign-in-b', 'digest-b1');

      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.invalidateAllForPerson(person, NOW),
      );

      expect(store.refreshTokens.get('a1')?.invalidatedAt).toEqual(NOW);
      expect(store.refreshTokens.get('b1')?.invalidatedAt).toEqual(NOW);
    });

    it('keeps the moment a session first ended', async () => {
      await insertToken('a1', 'sign-in-a', 'digest-a1');

      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.invalidateFamily(signInId('sign-in-a'), NOW),
      );
      await unitOfWork.runAuthenticating(({ sessions }) =>
        sessions.invalidateAllForPerson(person, LATER),
      );

      expect(store.refreshTokens.get('a1')?.invalidatedAt).toEqual(NOW);
    });

    it('discards its writes when the work throws', async () => {
      const attempt = unitOfWork.runAuthenticating(async ({ sessions }) => {
        await sessions.insert({
          id: 'doomed',
          signInId: signInId('sign-in-a'),
          personId: person,
          secretDigest: secretDigest('digest-doomed'),
          sessionExpiresAt: LATER,
        });
        throw new Error('the use case changed its mind');
      });

      await expect(attempt).rejects.toThrow('changed its mind');
      expect(store.refreshTokens.size).toBe(0);
    });
  });

  describe('API keys, in both audiences', () => {
    async function issue(
      tenant: typeof acme,
      id: string,
      label: string,
      digest: string,
    ): Promise<void> {
      await keys.scopedTo(tenant).insert({
        id: apiKeyId(id),
        label,
        role: 'editor',
        secretDigest: secretDigest(digest),
        createdAt: NOW,
      });
    }

    it('resolves a key without knowing the tenant in advance', async () => {
      await issue(globex, 'key-globex', 'sync', 'digest-globex');

      const resolved = await unitOfWork.runAuthenticating(({ apiKeys }) =>
        apiKeys.resolve(secretDigest('digest-globex')),
      );

      expect(resolved).toEqual({
        id: apiKeyId('key-globex'),
        tenantId: globex,
        role: 'editor',
      });
    });

    it('shows an administrator only their own tenant keys', async () => {
      await issue(acme, 'key-acme', 'sync', 'digest-acme');
      await issue(globex, 'key-globex', 'sync', 'digest-globex');

      await expect(keys.scopedTo(acme).list()).resolves.toEqual([
        expect.objectContaining({ id: apiKeyId('key-acme'), label: 'sync' }),
      ]);
    });

    it('never returns a secret in a listing', async () => {
      await issue(acme, 'key-acme', 'sync', 'digest-acme');

      const listed = await keys.scopedTo(acme).list();

      expect(JSON.stringify(listed)).not.toContain('digest-acme');
      expect(Object.keys(listed[0]).sort()).toEqual([
        'createdAt',
        'id',
        'label',
        'lastUsedAt',
        'revokedAt',
        'role',
      ]);
    });

    it('stops resolving a revoked key', async () => {
      await issue(acme, 'key-acme', 'sync', 'digest-acme');

      await keys.scopedTo(acme).revoke(apiKeyId('key-acme'), NOW);

      await expect(
        unitOfWork.runAuthenticating(({ apiKeys }) =>
          apiKeys.resolve(secretDigest('digest-acme')),
        ),
      ).resolves.toBeNull();
    });

    it('ignores a revocation aimed at another tenant key', async () => {
      await issue(globex, 'key-globex', 'sync', 'digest-globex');

      await keys.scopedTo(acme).revoke(apiKeyId('key-globex'), NOW);

      await expect(
        unitOfWork.runAuthenticating(({ apiKeys }) =>
          apiKeys.resolve(secretDigest('digest-globex')),
        ),
      ).resolves.not.toBeNull();
    });

    it('records when a key was last used', async () => {
      await issue(acme, 'key-acme', 'sync', 'digest-acme');

      await unitOfWork.runAuthenticating(({ apiKeys }) =>
        apiKeys.recordUse(apiKeyId('key-acme'), LATER),
      );

      const [summary] = await keys.scopedTo(acme).list();
      expect(summary.lastUsedAt).toEqual(LATER);
    });
  });

  describe('operator status', () => {
    it('reports only people recorded as operators', async () => {
      store.operators.add(person);

      const answers = await unitOfWork.runAuthenticating(
        async ({ operators }) => [
          await operators.isOperator(person),
          await operators.isOperator(personId('someone-else')),
        ],
      );

      expect(answers).toEqual([true, false]);
    });
  });

  it('never exposes an unused secret to a caller holding only a digest', () => {
    // The types carry this, but the assertion documents the intent: a digest is
    // one-way, and nothing in the store can return the value it came from.
    const secret = opaqueSecret('a-secret-value');
    expect(JSON.stringify([...store.setupTokens.values()])).not.toContain(
      secret,
    );
  });
});
