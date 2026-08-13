import { sql } from 'drizzle-orm';
import { check, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';

/**
 * Status is constrained text rather than an enum type: reactivation is a
 * deferred requirement, and widening a Postgres enum is materially more awkward
 * than editing a check constraint.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull().unique(),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'tenants_status_check',
      sql`${table.status} in ('active', 'inactive')`,
    ),
  ],
);
