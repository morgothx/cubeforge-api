import { eq } from 'drizzle-orm';
import type { TenantReadRepository } from '../../../application/ports/tenant.repository';
import type { TenantId } from '../../../domain/identifiers';
import type { Tenant } from '../../../domain/tenant/tenant.entity';
import { toTenant } from './row-mapping';
import { tenants } from './schema';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';

export class PostgresTenantReadRepository implements TenantReadRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  /**
   * The predicate is written out even though the policy restricts this identity
   * to exactly this row. That redundancy is deliberate: the two isolation
   * layers must not share a point of failure, so neither may be justified by
   * the other's existence.
   */
  async findCurrent(): Promise<Tenant | null> {
    const rows = await this.tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, this.tenantId))
      .limit(1);

    return rows.length === 0 ? null : toTenant(rows[0]);
  }
}
