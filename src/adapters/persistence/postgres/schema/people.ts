import { sql } from 'drizzle-orm';
import { check, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { citext, createdAt } from './columns';

/**
 * A person exists once for the whole platform, not once per tenant. That is
 * what allows one individual to hold memberships in several customers, and it
 * is why the email uniqueness below is platform-wide rather than scoped.
 */
export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').notNull().unique(),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'people_status_check',
      sql`${table.status} in ('active', 'deactivated')`,
    ),
  ],
);
