import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { tenants } from './tenants';

/**
 * A thing a tenant tracks, named by the SKU that tenant's own systems already
 * use.
 *
 * The SKU is the tenant's, not the platform's: two tenants may each track
 * `ACME-001` and mean unrelated things, so uniqueness is `(tenant_id, sku)` and
 * never `sku` alone. `tenant_id` is stored explicitly for the same reason it is
 * on every other tenant-owned table — it is the column both the repository
 * predicate and the row-level security policy key on.
 *
 * There is no deletion path, here or in the repository. Movements already
 * recorded point at this row, and the history has to stay readable.
 */
export const inventoryProducts = pgTable(
  'inventory_products',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    category: text('category'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Named, and not merely indexed: a movement's foreign key references this
    // constraint, which is what makes "product from another tenant" a shape the
    // database refuses rather than a check somebody has to remember.
    unique('inventory_products_tenant_sku_unique').on(
      table.tenantId,
      table.sku,
    ),
    index('inventory_products_tenant_idx').on(table.tenantId),
  ],
);
