import {
  catalogueKey,
  movementsKey,
  partitionDay,
  prefixFor,
  tenantSegment,
  watermarkKey,
} from './partition';
import { transactionId, windowFrom } from './window';

const TENANT = '018f2c00-0000-7000-8000-00000000ac01';
const WINDOW = windowFrom(transactionId(200n), transactionId(300n));

/**
 * Where a row lands.
 *
 * The tenant is in the path rather than in a column, so isolation is expressed
 * by the prefix a reader is pointed at instead of by a filter every query has
 * to remember. The day is the day the movement was **recorded**, never the day
 * it occurred: a backdated movement lands in today's partition, so a partition
 * already written is never rewritten.
 */
describe('where exported rows land', () => {
  it('partitions a movement by the day it was recorded, not the day it happened', () => {
    const key = movementsKey({
      tenantId: TENANT,
      day: partitionDay(new Date('2026-08-28T02:15:00.000Z')),
      window: WINDOW,
    });

    expect(key).toContain('recorded_date=2026-08-28');
  });

  it('names the tenant in the path', () => {
    const key = movementsKey({
      tenantId: TENANT,
      day: partitionDay(new Date('2026-08-28T02:15:00.000Z')),
      window: WINDOW,
    });

    expect(key).toContain(`tenant_id=${TENANT}`);
    // The dataset comes first and the tenant second, so a tenant has no single
    // prefix: everything of one tenant is three prefixes, one per dataset. That
    // is what lets a query engine point one table at `movements/` and read
    // `tenant_id` as a partition of it.
    expect(key.startsWith(prefixFor('movements', TENANT))).toBe(true);
    expect(prefixFor('movements', TENANT)).not.toBe(
      prefixFor('products', TENANT),
    );
  });

  it('names the file for its window, so a later run adds rather than replaces', () => {
    const first = movementsKey({
      tenantId: TENANT,
      day: partitionDay(new Date('2026-08-28T00:00:00.000Z')),
      window: windowFrom(transactionId(200n), transactionId(300n)),
    });
    const later = movementsKey({
      tenantId: TENANT,
      day: partitionDay(new Date('2026-08-28T23:00:00.000Z')),
      window: windowFrom(transactionId(300n), transactionId(400n)),
    });

    // Same day, different windows: two objects in one partition. A key naming
    // the run instead would be different on every retry, and a retry would add
    // a second copy of the same rows rather than replacing the first.
    expect(first).not.toBe(later);
    expect(first).toContain('200-300');
    expect(later).toContain('300-400');
  });

  it('gives the same window the same key, every time', () => {
    const arguments_ = {
      tenantId: TENANT,
      day: partitionDay(new Date('2026-08-28T10:00:00.000Z')),
      window: WINDOW,
    };

    // The property a replayed run depends on: the same window produces the same
    // name, so writing it again overwrites rather than duplicates.
    expect(movementsKey(arguments_)).toBe(movementsKey({ ...arguments_ }));
  });

  it('reads a day in UTC, so a partition means the same thing everywhere', () => {
    // Late evening in Bogotá is already the next day in UTC. Partitioning by
    // local time would put a movement in one partition on the machine that
    // wrote it and another on the machine that read it.
    const late = partitionDay(new Date('2026-08-28T23:30:00.000-05:00'));

    expect(late).toBe('2026-08-29');
  });

  it('gives the catalogue one fixed name per tenant', () => {
    const products = catalogueKey(TENANT, 'products');
    const locations = catalogueKey(TENANT, 'locations');

    // Fixed, because the catalogue is replaced whole every run: a reader looks
    // at one place and sees the catalogue as it is now.
    expect(products).toBe(catalogueKey(TENANT, 'products'));
    expect(products).not.toBe(locations);
    expect(products).toContain(`tenant_id=${TENANT}`);
  });

  it('keeps one tenant out of another tenant prefix', () => {
    const mine = tenantSegment(TENANT);
    const theirs = tenantSegment('018f2c00-0000-7000-8000-00000000ac02');

    expect(mine).not.toBe(theirs);
    expect(
      movementsKey({
        tenantId: TENANT,
        day: partitionDay(new Date('2026-08-28T00:00:00.000Z')),
        window: WINDOW,
      }),
    ).not.toContain('ac02');
  });

  it('refuses a tenant that is not an identifier', () => {
    // A key is a path. A tenant carrying a slash would write into a prefix that
    // is not its own, which is the one way this design could leak across
    // tenants without any query being wrong.
    expect(() => tenantSegment('../other-tenant')).toThrow();
    expect(() => tenantSegment('')).toThrow();
  });
});

describe('where a tenant says how far it has been carried', () => {
  it('names one place per tenant, so a run replaces rather than adds', () => {
    expect(watermarkKey(TENANT)).toBe(
      `watermarks/tenant_id=${TENANT}/watermark.parquet`,
    );
    expect(watermarkKey(TENANT)).toBe(watermarkKey(TENANT));
  });

  it('keeps the mark out of the datasets a reader queries for rows', () => {
    // Its own prefix, not a column on the movements: a table pointed at
    // `movements/` must find movements and nothing else.
    expect(watermarkKey(TENANT)).not.toContain('movements/');
    expect(watermarkKey(TENANT)).not.toContain('products/');
  });

  it('refuses a tenant that is not a path segment', () => {
    expect(() => watermarkKey('../elsewhere')).toThrow('path segment');
  });
});
