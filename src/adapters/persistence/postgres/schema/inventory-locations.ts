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
 * A place stock can be, named by the tenant's own code.
 *
 * The same shape as a product and for the same reasons. It is a declared
 * resource rather than free text on a movement because `WH-1`, `WH1` and `wh-1`
 * are three warehouses to anything that groups by them, and that mistake
 * surfaces months later as a total that is quietly wrong.
 */
export const inventoryLocations = pgTable(
  'inventory_locations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('inventory_locations_tenant_code_unique').on(
      table.tenantId,
      table.code,
    ),
    index('inventory_locations_tenant_idx').on(table.tenantId),
  ],
);
