import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { people } from './people';
import { tenants } from './tenants';

/**
 * The link granting a person access to one tenant, carrying the role for that
 * tenant only.
 *
 * `tenant_id` is stored explicitly even though it is reachable by joining
 * through the person: it is the column both the repository predicate and the
 * row-level security policy key on, and the whole isolation guarantee rests on
 * it being present and indexed.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (table) => [
    // One membership per person per tenant, enforced by the database so the
    // duplicate check is not a race between reading and inserting.
    unique('memberships_tenant_person_unique').on(
      table.tenantId,
      table.personId,
    ),
    index('memberships_tenant_idx').on(table.tenantId),
    check(
      'memberships_role_check',
      sql`${table.role} in ('admin', 'editor', 'viewer')`,
    ),
    check(
      'memberships_status_check',
      sql`${table.status} in ('active', 'revoked')`,
    ),
  ],
);
