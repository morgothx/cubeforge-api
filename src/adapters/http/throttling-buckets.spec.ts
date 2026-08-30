import 'reflect-metadata';
import { SkipThrottle } from '@nestjs/throttler';
import { AnalyticsController } from './analytics.controller';
import { AuthenticationController } from './authentication.controller';
import { InventoryLocationsController } from './inventory-locations.controller';
import { InventoryMovementsController } from './inventory-movements.controller';
import { InventoryProductsController } from './inventory-products.controller';
import { InventoryStockController } from './inventory-stock.controller';
import { platformThrottlerOptions } from './platform-throttling';
import {
  ANALYTICS_BY_CALLER,
  EVERY_BUCKET,
  everyBucketExcept,
  INVENTORY_BY_CREDENTIAL,
} from './throttling-buckets';
import {
  REDEMPTION_BY_ORIGIN,
  SIGN_IN_BY_ADDRESS,
  SIGN_IN_BY_ORIGIN,
} from './credential-throttling';

/**
 * The prefix `@SkipThrottle` writes its metadata under, discovered rather than
 * spelled out.
 *
 * `THROTTLER_SKIP` is declared in the package's type definitions but is not
 * exported at runtime — importing it yields `undefined`, which silently turns
 * every lookup below into a miss and every assertion into a comparison of two
 * empty objects. Found exactly that way. Applying the decorator to a throwaway
 * class and reading back which key appeared cannot go quietly wrong: if the
 * library changes its key, this throws instead of passing vacuously.
 */
const SKIP_PREFIX = (() => {
  const bucket = 'a-bucket-nothing-registers';
  class Probe {}
  SkipThrottle({ [bucket]: true })(Probe);

  const key = Reflect.getMetadataKeys(Probe)
    .map(String)
    .find((candidate) => candidate.endsWith(bucket));
  if (key === undefined) {
    throw new Error('SkipThrottle no longer records a metadata key per bucket');
  }
  return key.slice(0, key.length - bucket.length);
})();

/**
 * What `@SkipThrottle` actually wrote, read the way the guard reads it: one
 * metadata key per bucket, not one map for all of them.
 */
function skippedBy(target: object): Record<string, boolean> {
  return Object.fromEntries(
    EVERY_BUCKET.filter(
      (bucket) => Reflect.getMetadata(SKIP_PREFIX + bucket, target) === true,
    ).map((bucket) => [bucket, true]),
  );
}

describe('the platform throttling buckets', () => {
  it('names every bucket the platform registers', () => {
    expect([...EVERY_BUCKET].sort()).toEqual(
      [
        SIGN_IN_BY_ORIGIN,
        SIGN_IN_BY_ADDRESS,
        REDEMPTION_BY_ORIGIN,
        INVENTORY_BY_CREDENTIAL,
        ANALYTICS_BY_CALLER,
      ].sort(),
    );
  });

  /**
   * The property that matters: a route skips **everything but its own**.
   *
   * `ThrottlerModule` is global, so a bucket a route does not skip counts that
   * route — and every skip list on this platform was written by hand as "the
   * buckets that existed when I was written". A fifth bucket therefore had to
   * be added to four separate lists to avoid counting four features' routes
   * with a tracker meant for none of them. This is that list, derived once.
   */
  it('skips every bucket but the one whose route is asking', () => {
    expect(everyBucketExcept(ANALYTICS_BY_CALLER)).toEqual({
      [SIGN_IN_BY_ORIGIN]: true,
      [SIGN_IN_BY_ADDRESS]: true,
      [REDEMPTION_BY_ORIGIN]: true,
      [INVENTORY_BY_CREDENTIAL]: true,
    });
  });

  it('lets a route own more than one bucket', () => {
    const skipped = everyBucketExcept(SIGN_IN_BY_ORIGIN, SIGN_IN_BY_ADDRESS);

    expect(skipped[SIGN_IN_BY_ORIGIN]).toBeUndefined();
    expect(skipped[SIGN_IN_BY_ADDRESS]).toBeUndefined();
    expect(skipped[ANALYTICS_BY_CALLER]).toBe(true);
  });

  it('refuses a bucket the platform does not register', () => {
    expect(() => everyBucketExcept('invented')).toThrow('invented');
  });

  /**
   * A bucket declared here and never registered would be skipped by every route
   * and count nothing — a limit that exists only in this file. The composition
   * is one function so that `AppModule` cannot register a different set from
   * the one every skip list is derived from.
   */
  it('registers every bucket it names', () => {
    const registered = platformThrottlerOptions({});

    expect(registered.map((option) => option.name).sort()).toEqual(
      [...EVERY_BUCKET].sort(),
    );
  });

  /**
   * The property the registry exists for, asserted on the shipped routes.
   *
   * Deriving the skip list makes the mistake unrepresentable, and a probe that
   * restored one feature's hand-written list proved nothing was watching: every
   * test passed with inventory routes counted by the analytics bucket. Nothing
   * had ever asserted what a controller actually skips — the registry was an
   * argument, and this is the test.
   */
  it.each([
    [
      'inventory products',
      InventoryProductsController,
      INVENTORY_BY_CREDENTIAL,
    ],
    [
      'inventory locations',
      InventoryLocationsController,
      INVENTORY_BY_CREDENTIAL,
    ],
    [
      'inventory movements',
      InventoryMovementsController,
      INVENTORY_BY_CREDENTIAL,
    ],
    ['inventory stock', InventoryStockController, INVENTORY_BY_CREDENTIAL],
    ['analytics', AnalyticsController, ANALYTICS_BY_CALLER],
  ])(
    'has the %s routes skip every bucket but their own',
    (_name, controller, owned) => {
      expect(skippedBy(controller)).toEqual(everyBucketExcept(owned));
    },
  );

  /** Sign-in owns two buckets; redemption owns one. Both live on handlers. */
  it('has each authentication handler skip every bucket but its own', () => {
    const handler = (name: string): object =>
      (AuthenticationController.prototype as unknown as Record<string, object>)[
        name
      ];

    expect(skippedBy(handler('store'))).toEqual(
      everyBucketExcept(SIGN_IN_BY_ORIGIN, SIGN_IN_BY_ADDRESS),
    );
    expect(skippedBy(handler('establish'))).toEqual(
      everyBucketExcept(REDEMPTION_BY_ORIGIN),
    );
  });
});
