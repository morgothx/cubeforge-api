import { customType, timestamp } from 'drizzle-orm/pg-core';

/**
 * Case-insensitive text. Email uniqueness is what decides whether a person
 * already exists platform-wide, and the domain already normalizes before
 * writing — but the database enforces it independently, so a future code path
 * that skips normalization cannot create the same person twice.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
