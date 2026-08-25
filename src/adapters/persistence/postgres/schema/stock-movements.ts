import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { inventoryLocations } from './inventory-locations';
import { inventoryProducts } from './inventory-products';
import { tenants } from './tenants';

/**
 * Something that happened to stock. Append-only: never updated, never deleted.
 *
 * Stock on hand is the sum of these rows, not a column somebody keeps correct.
 * A snapshot that overwrites itself has no history, and history is the whole
 * reason the analytical half of this platform has anything to read.
 *
 * **Two timestamps, and the distinction is load-bearing.** `occurred_at` is
 * when the movement happened, as the source system reports it, and may be
 * backdated. `recorded_at` is when this platform stored it and only ever moves
 * forward. A later incremental export keys on `recorded_at`, because an export
 * partitioned by `occurred_at` has to rewrite a partition every time a
 * backdated movement lands in it. Storing only the first would mean adding a
 * column later to a table that by then has history in it.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The identifier the source system supplied — its own document number.
     *
     * This is the idempotency mechanism. Unique within a tenant and deliberately
     * not across the platform: the same number arriving from a different tenant
     * is a different movement, and refusing it would disclose that another
     * tenant had used it.
     */
    externalId: text('external_id').notNull(),
    sku: text('sku').notNull(),
    locationCode: text('location_code').notNull(),
    kind: text('kind').notNull(),
    quantity: integer('quantity').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The constraint a retry relies on. `INSERT … ON CONFLICT DO NOTHING
    // RETURNING` observes this rather than predicting it: reading first and
    // inserting second is a race two concurrent retries eventually lose.
    unique('stock_movements_tenant_external_unique').on(
      table.tenantId,
      table.externalId,
    ),
    // Composite, carrying the tenant, rather than a reference to the SKU alone.
    // A single-column reference into a tenant-scoped table would let a movement
    // point at another tenant's product if a policy were ever misapplied; this
    // makes that unrepresentable rather than merely forbidden.
    foreignKey({
      name: 'stock_movements_product_fk',
      columns: [table.tenantId, table.sku],
      foreignColumns: [inventoryProducts.tenantId, inventoryProducts.sku],
    }),
    foreignKey({
      name: 'stock_movements_location_fk',
      columns: [table.tenantId, table.locationCode],
      foreignColumns: [inventoryLocations.tenantId, inventoryLocations.code],
    }),
    check(
      'stock_movements_kind_check',
      sql`${table.kind} in ('receipt', 'sale', 'adjustment')`,
    ),
    // Zero is not a movement. Refused here as well as in the domain, because a
    // rule the database does not hold is a rule a future code path can skip.
    check('stock_movements_quantity_check', sql`${table.quantity} <> 0`),
    // The sum, per product and place, is the only read this table serves until
    // the analytical pipeline exists.
    index('stock_movements_tenant_sku_location_idx').on(
      table.tenantId,
      table.sku,
      table.locationCode,
    ),
    // What a later incremental export will walk.
    index('stock_movements_tenant_recorded_idx').on(
      table.tenantId,
      table.recordedAt,
    ),
  ],
);
