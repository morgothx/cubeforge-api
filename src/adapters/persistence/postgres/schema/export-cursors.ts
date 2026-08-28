import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { xid8 } from './xid8';

/**
 * How far each tenant's export has been carried.
 *
 * **Two phases, deliberately.** `exportedThrough` is the point carried through
 * and confirmed; `pendingFrom`/`pendingTo` is the window a run is part-way
 * through. A run records its window before writing anything and confirms it
 * afterwards, so a run that dies in between leaves the window recorded rather
 * than lost. The next run finishes *that* window instead of computing a new
 * one, which is what makes the objects it writes the same objects under the
 * same keys — and rewriting the same key with the same rows is how a failed run
 * is finished rather than duplicated.
 *
 * There is no `deletedAt` and no delete grant. Forgetting how far a tenant was
 * carried is not an operation this feature wants to have.
 */
export const exportCursors = pgTable(
  'export_cursors',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * `movements` today. The column exists so that a second dataset is a row
     * rather than a migration on a table that by then holds every tenant's
     * position.
     */
    dataset: text('dataset').notNull(),
    exportedThrough: xid8('exported_through'),
    pendingFrom: xid8('pending_from'),
    pendingTo: xid8('pending_to'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'export_cursors_pkey',
      columns: [table.tenantId, table.dataset],
    }),
    // Half a window is not a window: a start with no end is a run nobody can
    // finish, and the next run could not tell whether to replay or start fresh.
    check(
      'export_cursors_pending_pair_check',
      sql`(${table.pendingFrom} IS NULL) = (${table.pendingTo} IS NULL)`,
    ),
    check(
      'export_cursors_pending_order_check',
      sql`${table.pendingFrom} IS NULL OR ${table.pendingFrom} < ${table.pendingTo}`,
    ),
  ],
);
