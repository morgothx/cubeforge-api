import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  ProductAttributes,
  ProductRepository,
} from '../../../application/ports/product.repository';
import type {
  Declaration,
  ReferenceEntity,
} from '../../../application/ports/reference.repository';
import type { Sku } from '../../../domain/inventory/identifiers';
import { sku as parseSku } from '../../../domain/inventory/identifiers';
import type { TenantId } from '../../../domain/identifiers';
import { inventoryProducts } from './schema';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';

export class PostgresProductRepository implements ProductRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  /**
   * Every query carries the tenant explicitly. The row-level security policy
   * applies the same restriction independently, and that duplication is the
   * design: two layers that cannot fail together.
   */
  private get scope() {
    return eq(inventoryProducts.tenantId, this.tenantId);
  }

  async declare(
    code: Sku,
    attributes: ProductAttributes,
  ): Promise<Declaration> {
    const rows = await this.tx
      .insert(inventoryProducts)
      .values({
        id: randomUUID(),
        tenantId: this.tenantId,
        sku: code,
        name: attributes.name,
        category: attributes.category,
      })
      .onConflictDoUpdate({
        target: [inventoryProducts.tenantId, inventoryProducts.sku],
        set: {
          name: attributes.name,
          category: attributes.category,
          updatedAt: sql`now()`,
        },
      })
      // One statement rather than a read and then a write: the two are a race,
      // and two synchronisations declaring the same product at once would both
      // decide it was absent. `xmax` is zero on a row this statement inserted
      // and non-zero on one it updated, which is how the single statement can
      // still say which of the two it did.
      .returning({ inserted: sql<boolean>`(xmax = 0)` });

    return rows[0]?.inserted ? 'created' : 'updated';
  }

  async declared(codes: readonly Sku[]): Promise<ReadonlySet<Sku>> {
    if (codes.length === 0) {
      // `inArray` with an empty list is not a question worth asking, and some
      // dialects refuse it outright.
      return new Set();
    }

    const rows = await this.tx
      .select({ sku: inventoryProducts.sku })
      .from(inventoryProducts)
      .where(and(this.scope, inArray(inventoryProducts.sku, [...codes])));

    return new Set(rows.map((row) => row.sku as Sku));
  }

  async list(): Promise<readonly (ReferenceEntity<Sku> & ProductAttributes)[]> {
    const rows = await this.tx
      .select()
      .from(inventoryProducts)
      .where(this.scope)
      .orderBy(inventoryProducts.sku);

    return rows.map((row) => ({
      code: parseSku(row.sku),
      name: row.name,
      // Carried rather than dropped: it is the one attribute an analytical
      // reader groups by, and the export is its first reader.
      category: row.category,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}
