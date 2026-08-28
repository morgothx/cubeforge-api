import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL's 64-bit transaction identifier.
 *
 * Drizzle has no `xid8`, and the alternative — reading the 32-bit `xmin` system
 * column — would mean reasoning about wraparound every time two identifiers are
 * compared. `xid8` carries its epoch, so a comparison is a comparison.
 *
 * It arrives from the driver as a string, because 64 bits do not fit a
 * JavaScript number. It is kept as a `bigint` rather than parsed to a number
 * for the same reason.
 */
export const xid8 = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'xid8',
  fromDriver: (value) => BigInt(value),
  toDriver: (value) => value.toString(),
});
