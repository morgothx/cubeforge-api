import type {
  ApiKeyRepository,
  ApiKeySummary,
  ResolvedApiKey,
} from '../../../application/ports/api-key.repository';
import type { SecretDigest } from '../../../domain/credential/secrets';
import type { ApiKeyId, TenantId } from '../../../domain/identifiers';
import type { Role } from '../../../domain/membership/role';
import type { InMemoryApiKeys } from './in-memory-authenticator-unit-of-work';

interface StoredApiKey {
  id: ApiKeyId;
  tenantId: TenantId;
  label: string;
  role: Role;
  secretDigest: SecretDigest;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * One store, two audiences — mirroring the single `api_keys` table with two
 * policies. Resolution searches every tenant because the key is what names the
 * tenant; management is scoped, like every other tenant-owned thing.
 */
export class InMemoryApiKeyStore implements InMemoryApiKeys {
  private readonly keys = new Map<ApiKeyId, StoredApiKey>();

  /** A revoked key resolves to nothing, which is what revocation means. */
  resolve(digest: SecretDigest): ResolvedApiKey | null {
    for (const key of this.keys.values()) {
      if (key.secretDigest === digest && key.revokedAt === null) {
        return { id: key.id, tenantId: key.tenantId, role: key.role };
      }
    }
    return null;
  }

  recordUse(id: ApiKeyId, at: Date): void {
    const key = this.keys.get(id);
    if (key) {
      this.keys.set(id, { ...key, lastUsedAt: at });
    }
  }

  scopedTo(tenantId: TenantId): ApiKeyRepository {
    return new InMemoryApiKeyRepository(this.keys, tenantId);
  }
}

class InMemoryApiKeyRepository implements ApiKeyRepository {
  constructor(
    private readonly keys: Map<ApiKeyId, StoredApiKey>,
    private readonly tenantId: TenantId,
  ) {}

  private scoped(): StoredApiKey[] {
    return [...this.keys.values()].filter(
      (key) => key.tenantId === this.tenantId,
    );
  }

  insert(key: {
    readonly id: ApiKeyId;
    readonly label: string;
    readonly role: Role;
    readonly secretDigest: SecretDigest;
    readonly createdAt: Date;
  }): Promise<void> {
    this.keys.set(key.id, {
      ...key,
      tenantId: this.tenantId,
      lastUsedAt: null,
      revokedAt: null,
    });
    return Promise.resolve();
  }

  list(): Promise<ApiKeySummary[]> {
    return Promise.resolve(this.scoped().map(summarize));
  }

  findById(id: ApiKeyId): Promise<ApiKeySummary | null> {
    const key = this.scoped().find((candidate) => candidate.id === id);
    return Promise.resolve(key ? summarize(key) : null);
  }

  /**
   * Silently ignores a key belonging to another tenant, matching what the
   * policy does to an update whose predicate excludes the row: no rows change,
   * no error. A use case must not infer existence from a successful revoke.
   */
  revoke(id: ApiKeyId, at: Date): Promise<void> {
    const key = this.scoped().find((candidate) => candidate.id === id);
    if (key && key.revokedAt === null) {
      this.keys.set(key.id, { ...key, revokedAt: at });
    }
    return Promise.resolve();
  }
}

/** The secret is deliberately absent: requirement 7.2 shows it once, at issuance. */
function summarize(key: StoredApiKey): ApiKeySummary {
  return {
    id: key.id,
    label: key.label,
    role: key.role,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  };
}
