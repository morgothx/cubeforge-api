import { and, eq, isNull } from 'drizzle-orm';
import type {
  ApiKeyRepository,
  ApiKeySummary,
} from '../../../application/ports/api-key.repository';
import type { SecretDigest } from '../../../domain/credential/secrets';
import {
  apiKeyId,
  type ApiKeyId,
  type TenantId,
} from '../../../domain/identifiers';
import type { Role } from '../../../domain/membership/role';
import { parseRole } from '../../../domain/membership/role';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';
import { apiKeys } from './schema';

/**
 * The administrator's view of a tenant's keys.
 *
 * Every query carries `tenant_id = <current tenant>` explicitly even though the
 * policy applies the same restriction, for the reason every tenant-scoped
 * repository here does: the two isolation layers must not share a point of
 * failure.
 */
export class PostgresApiKeyRepository implements ApiKeyRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  private get scope() {
    return eq(apiKeys.tenantId, this.tenantId);
  }

  async insert(key: {
    readonly id: ApiKeyId;
    readonly label: string;
    readonly role: Role;
    readonly secretDigest: SecretDigest;
    readonly createdAt: Date;
  }): Promise<void> {
    await this.tx.insert(apiKeys).values({
      id: key.id,
      tenantId: this.tenantId,
      label: key.label,
      role: key.role,
      secretDigest: key.secretDigest,
      createdAt: key.createdAt,
    });
  }

  async list(): Promise<ApiKeySummary[]> {
    const rows = await this.tx
      .select()
      .from(apiKeys)
      .where(this.scope)
      .orderBy(apiKeys.createdAt);

    return rows.map(toSummary);
  }

  async findById(id: ApiKeyId): Promise<ApiKeySummary | null> {
    const rows = await this.tx
      .select()
      .from(apiKeys)
      .where(and(this.scope, eq(apiKeys.id, id)))
      .limit(1);

    return rows.length === 0 ? null : toSummary(rows[0]);
  }

  /**
   * Only an unrevoked key is touched, so revoking twice keeps the first moment.
   * When it happened is the fact worth not overwriting.
   */
  async revoke(id: ApiKeyId, at: Date): Promise<void> {
    await this.tx
      .update(apiKeys)
      .set({ revokedAt: at })
      .where(and(this.scope, eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
  }
}

interface ApiKeyRow {
  id: string;
  label: string;
  role: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** The secret is absent by construction: it is shown once, at issuance. */
export function toSummary(row: ApiKeyRow): ApiKeySummary {
  const role = parseRole(row.role);
  if (!role.ok) {
    throw new Error(
      `api_keys.role holds "${row.role}", which is not one of: ${role.permitted.join(', ')}`,
    );
  }
  return {
    id: apiKeyId(row.id),
    label: row.label,
    role: role.role,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}
