import type {
  ApiKeyResolvingRepository,
  ResolvedApiKey,
} from '../../../application/ports/api-key.repository';
import type {
  AuthenticatorRepositories,
  AuthenticatorUnitOfWork,
  OperatorStatusRepository,
} from '../../../application/ports/authenticator-unit-of-work';
import type {
  CredentialRepository,
  SetupTokenRecord,
  StoredCredential,
} from '../../../application/ports/credential.repository';
import type {
  SessionRepository,
  StoredRefreshToken,
} from '../../../application/ports/session.repository';
import type {
  PasswordDigest,
  SecretDigest,
} from '../../../domain/credential/secrets';
import type {
  ApiKeyId,
  EmailAddress,
  PersonId,
  SignInId,
} from '../../../domain/identifiers';
import type { PersonStatus } from '../../../domain/person/person.entity';
import { InMemoryCredentialStore } from './in-memory-credential-store';

/** The API keys a test has arranged, keyed by digest for resolution. */
export interface InMemoryApiKeys {
  resolve(digest: SecretDigest): ResolvedApiKey | null;
  recordUse(id: ApiKeyId, at: Date): void;
}

/**
 * The test double for the authenticating unit of work.
 *
 * Like the tenant-scoped double it discards its writes when the work throws,
 * because a use case that rejects a sign-in must leave no session behind and a
 * double that kept them would let that through.
 */
export class InMemoryAuthenticatorUnitOfWork implements AuthenticatorUnitOfWork {
  constructor(
    private readonly store: InMemoryCredentialStore,
    private readonly apiKeys: InMemoryApiKeys,
  ) {}

  async runAuthenticating<T>(
    work: (repositories: AuthenticatorRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = {
      passwords: new Map(this.store.passwords),
      setupTokens: new Map(this.store.setupTokens),
      refreshTokens: new Map(this.store.refreshTokens),
    };
    try {
      return await work({
        credentials: new InMemoryCredentialRepository(this.store),
        sessions: new InMemorySessionRepository(this.store),
        apiKeys: new InMemoryApiKeyResolvingRepository(this.apiKeys),
        operators: new InMemoryOperatorStatusRepository(this.store),
      });
    } catch (error) {
      replace(this.store.passwords, snapshot.passwords);
      replace(this.store.setupTokens, snapshot.setupTokens);
      replace(this.store.refreshTokens, snapshot.refreshTokens);
      throw error;
    }
  }
}

class InMemoryCredentialRepository implements CredentialRepository {
  constructor(private readonly store: InMemoryCredentialStore) {}

  findByEmail(email: EmailAddress): Promise<StoredCredential | null> {
    return Promise.resolve(this.toCredential(this.store.personByEmail(email)));
  }

  findByPerson(personId: PersonId): Promise<StoredCredential | null> {
    return Promise.resolve(this.toCredential(this.store.personById(personId)));
  }

  private toCredential(
    person: { id: PersonId; status: PersonStatus } | null,
  ): StoredCredential | null {
    if (person === null) {
      return null;
    }
    return {
      personId: person.id,
      personStatus: person.status,
      passwordDigest: this.store.passwords.get(person.id)?.digest ?? null,
    };
  }

  establishPassword(
    personId: PersonId,
    digest: PasswordDigest,
    at: Date,
  ): Promise<void> {
    this.store.passwords.set(personId, { digest, updatedAt: at });
    return Promise.resolve();
  }

  findSetupToken(digest: SecretDigest): Promise<SetupTokenRecord | null> {
    for (const token of this.store.setupTokens.values()) {
      if (token.secretDigest === digest) {
        return Promise.resolve({
          id: token.id,
          personId: token.personId,
          expiresAt: token.expiresAt,
          redeemedAt: token.redeemedAt,
        });
      }
    }
    return Promise.resolve(null);
  }

  markSetupTokenRedeemed(id: string, at: Date): Promise<void> {
    const token = this.store.setupTokens.get(id);
    if (token) {
      this.store.setupTokens.set(id, { ...token, redeemedAt: at });
    }
    return Promise.resolve();
  }
}

class InMemorySessionRepository implements SessionRepository {
  constructor(private readonly store: InMemoryCredentialStore) {}

  insert(token: {
    readonly id: string;
    readonly signInId: SignInId;
    readonly personId: PersonId;
    readonly secretDigest: SecretDigest;
    readonly sessionExpiresAt: Date;
  }): Promise<void> {
    this.store.refreshTokens.set(token.id, {
      ...token,
      exchangedAt: null,
      invalidatedAt: null,
    });
    return Promise.resolve();
  }

  findByDigest(digest: SecretDigest): Promise<StoredRefreshToken | null> {
    for (const token of this.store.refreshTokens.values()) {
      if (token.secretDigest === digest) {
        return Promise.resolve(token);
      }
    }
    return Promise.resolve(null);
  }

  markExchanged(id: string, at: Date): Promise<void> {
    const token = this.store.refreshTokens.get(id);
    if (token) {
      this.store.refreshTokens.set(id, { ...token, exchangedAt: at });
    }
    return Promise.resolve();
  }

  invalidateFamily(signInId: SignInId, at: Date): Promise<void> {
    return this.invalidateWhere((token) => token.signInId === signInId, at);
  }

  invalidateAllForPerson(personId: PersonId, at: Date): Promise<void> {
    return this.invalidateWhere((token) => token.personId === personId, at);
  }

  /**
   * Already-invalidated tokens keep their original timestamp. The moment a
   * session ended is a fact worth not overwriting, and re-invalidating is
   * common — signing out a person whose family already ended, for instance.
   */
  private invalidateWhere(
    matches: (token: { signInId: SignInId; personId: PersonId }) => boolean,
    at: Date,
  ): Promise<void> {
    for (const [id, token] of this.store.refreshTokens) {
      if (matches(token) && token.invalidatedAt === null) {
        this.store.refreshTokens.set(id, { ...token, invalidatedAt: at });
      }
    }
    return Promise.resolve();
  }
}

class InMemoryApiKeyResolvingRepository implements ApiKeyResolvingRepository {
  constructor(private readonly keys: InMemoryApiKeys) {}

  resolve(digest: SecretDigest): Promise<ResolvedApiKey | null> {
    return Promise.resolve(this.keys.resolve(digest));
  }

  recordUse(id: ApiKeyId, at: Date): Promise<void> {
    this.keys.recordUse(id, at);
    return Promise.resolve();
  }
}

class InMemoryOperatorStatusRepository implements OperatorStatusRepository {
  constructor(private readonly store: InMemoryCredentialStore) {}

  /** Recorded *and* still an active person; see the Postgres implementation. */
  isOperator(personId: PersonId): Promise<boolean> {
    return Promise.resolve(
      this.store.operators.has(personId) &&
        this.store.personById(personId)?.status === 'active',
    );
  }
}

function replace<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}
