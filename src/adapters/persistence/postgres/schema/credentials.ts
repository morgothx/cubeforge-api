import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt } from './columns';
import { people } from './people';
import { tenants } from './tenants';

/**
 * A person's password, kept away from `people` on purpose.
 *
 * `people` is readable by the tenant-scoped runtime identity under
 * `people_app_read`, and that grant is table-wide rather than column-scoped. A
 * digest stored there would be visible to every tenant the person belongs to.
 */
export const personCredentials = pgTable('person_credentials', {
  personId: uuid('person_id')
    .primaryKey()
    .references(() => people.id),
  passwordDigest: text('password_digest').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A one-time token an operator hands to a person so they can set a password.
 * Only its digest is stored, so the platform cannot reproduce the token it
 * issued — losing it means issuing another, which is the correct outcome.
 */
export const credentialSetupTokens = pgTable(
  'credential_setup_tokens',
  {
    id: uuid('id').primaryKey(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    secretDigest: text('secret_digest').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index('credential_setup_tokens_person_idx').on(table.personId)],
);

/**
 * One row per refresh token, not per session. Rotation replaces a row and
 * `sign_in_id` keeps the family together, which is what lets a replayed token
 * end every descendant of the same sign-in at once.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    signInId: uuid('sign_in_id').notNull(),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id),
    secretDigest: text('secret_digest').notNull().unique(),
    sessionExpiresAt: timestamp('session_expires_at', {
      withTimezone: true,
    }).notNull(),
    exchangedAt: timestamp('exchanged_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('refresh_tokens_sign_in_idx').on(table.signInId),
    index('refresh_tokens_person_idx').on(table.personId),
  ],
);

/**
 * Tenant-owned data and a credential at the same time — the only table with two
 * audiences. Authentication resolves a key before any tenant is known, while an
 * administrator manages keys strictly within their own tenant.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    role: text('role').notNull(),
    secretDigest: text('secret_digest').notNull().unique(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique('api_keys_tenant_label_unique').on(table.tenantId, table.label),
    index('api_keys_tenant_idx').on(table.tenantId),
    check(
      'api_keys_role_check',
      sql`${table.role} in ('admin', 'editor', 'viewer')`,
    ),
  ],
);

/**
 * Operator status is a fact about a person, and its absence is the default.
 * There is no `revoked_at`: withdrawing the status deletes the row, because
 * unlike a tenant membership it attributes no historical data.
 */
export const platformOperators = pgTable('platform_operators', {
  personId: uuid('person_id')
    .primaryKey()
    .references(() => people.id),
  grantedAt: timestamp('granted_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
