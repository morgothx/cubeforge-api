import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  LocationAttributes,
  LocationRepository,
} from '../../../application/ports/location.repository';
import type {
  Declaration,
  ReferenceEntity,
} from '../../../application/ports/reference.repository';
import type { LocationCode } from '../../../domain/inventory/identifiers';
import { locationCode } from '../../../domain/inventory/identifiers';
import type { TenantId } from '../../../domain/identifiers';
import { inventoryLocations } from './schema';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';

/**
 * The same shape as the product catalogue, written out rather than shared with
 * it through a base class. The two have nothing in common but their shape, and
 * a parent class would be inheritance standing in for a type — the interface
 * already says everything they share.
 */
export class PostgresLocationRepository implements LocationRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  private get scope() {
    return eq(inventoryLocations.tenantId, this.tenantId);
  }

  async declare(
    code: LocationCode,
    attributes: LocationAttributes,
  ): Promise<Declaration> {
    const rows = await this.tx
      .insert(inventoryLocations)
      .values({
        id: randomUUID(),
        tenantId: this.tenantId,
        code,
        name: attributes.name,
      })
      .onConflictDoUpdate({
        target: [inventoryLocations.tenantId, inventoryLocations.code],
        set: { name: attributes.name, updatedAt: sql`now()` },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });

    return rows[0]?.inserted ? 'created' : 'updated';
  }

  async declared(
    codes: readonly LocationCode[],
  ): Promise<ReadonlySet<LocationCode>> {
    if (codes.length === 0) {
      return new Set();
    }

    const rows = await this.tx
      .select({ code: inventoryLocations.code })
      .from(inventoryLocations)
      .where(and(this.scope, inArray(inventoryLocations.code, [...codes])));

    return new Set(rows.map((row) => row.code as LocationCode));
  }

  async list(): Promise<readonly ReferenceEntity<LocationCode>[]> {
    const rows = await this.tx
      .select()
      .from(inventoryLocations)
      .where(this.scope)
      .orderBy(inventoryLocations.code);

    return rows.map((row) => ({
      code: locationCode(row.code),
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}
