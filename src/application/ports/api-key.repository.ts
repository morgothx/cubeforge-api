import type { SecretDigest } from '../../domain/credential/secrets';
import type { ApiKeyId, TenantId } from '../../domain/identifiers';
import type { Role } from '../../domain/membership/role';

/**
 * What resolving a key yields: enough to act, and nothing more. The label and
 * the timestamps belong to the administrator's view, not to authentication.
 */
export interface ResolvedApiKey {
  readonly id: ApiKeyId;
  readonly tenantId: TenantId;
  readonly role: Role;
}

/**
 * The authenticating half. It runs with no tenant published, because the key is
 * what names the tenant — resolving one under a tenant-keyed policy would be
 * circular.
 */
export interface ApiKeyResolvingRepository {
  resolve(digest: SecretDigest): Promise<ResolvedApiKey | null>;

  /** Requirement 7.8. Separate from resolution so a read stays a read. */
  recordUse(id: ApiKeyId, at: Date): Promise<void>;
}

export interface ApiKeySummary {
  readonly id: ApiKeyId;
  readonly label: string;
  readonly role: Role;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * The administrator's half, tenant-scoped like every other tenant-owned table.
 * No method returns a secret: requirement 7.2 says the secret is shown once, at
 * issuance, and a contract that could return it later would eventually be asked
 * to.
 */
export interface ApiKeyRepository {
  insert(key: {
    readonly id: ApiKeyId;
    readonly label: string;
    readonly role: Role;
    readonly secretDigest: SecretDigest;
    readonly createdAt: Date;
  }): Promise<void>;

  list(): Promise<ApiKeySummary[]>;

  findById(id: ApiKeyId): Promise<ApiKeySummary | null>;

  revoke(id: ApiKeyId, at: Date): Promise<void>;
}
