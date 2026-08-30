import { Injectable } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  BucketThrottlerGuard,
  callerOf,
  everyBucketExcept,
  INVENTORY_BY_CREDENTIAL,
} from './throttling-buckets';

export { INVENTORY_BY_CREDENTIAL };

/** Every bucket an inventory route must not be counted by. */
export const OTHER_BUCKETS = everyBucketExcept(INVENTORY_BY_CREDENTIAL);

export interface InventoryThrottlingConfig {
  readonly windowSeconds: number;
  /**
   * Requests per credential per window.
   *
   * Sixty against a batch of five hundred is thirty thousand movements a
   * minute, which covers a nightly synchronisation with room to spare while
   * still stopping a caller that loops.
   */
  readonly requestsPerCredential: number;
}

const BASELINE: InventoryThrottlingConfig = {
  windowSeconds: 60,
  requestsPerCredential: 60,
};

type Env = Record<string, string | undefined>;

export function loadInventoryThrottlingConfig(
  env: Env,
): InventoryThrottlingConfig {
  return {
    windowSeconds: positiveInteger(
      env.INVENTORY_THROTTLE_WINDOW_SECONDS,
      'INVENTORY_THROTTLE_WINDOW_SECONDS',
      BASELINE.windowSeconds,
    ),
    requestsPerCredential: positiveInteger(
      env.INVENTORY_REQUESTS_PER_CREDENTIAL,
      'INVENTORY_REQUESTS_PER_CREDENTIAL',
      BASELINE.requestsPerCredential,
    ),
  };
}

/**
 * The inventory bucket, counted **per credential**.
 *
 * Not per tenant: two integrations in one tenant are two callers, and letting
 * an eager one silence the other would make an unrelated system's misbehaviour
 * indistinguishable from an outage. Not per origin either — a warehouse system
 * and a point-of-sale can sit behind one address, and a key is the thing that
 * actually identifies a caller here.
 */
export function inventoryThrottlerOptions(
  config: InventoryThrottlingConfig,
): ThrottlerOptions[] {
  return [
    {
      name: INVENTORY_BY_CREDENTIAL,
      ttl: config.windowSeconds * 1000,
      limit: config.requestsPerCredential,
      getTracker: (request: Record<string, unknown>) =>
        callerOf(request as unknown as Request),
    },
  ];
}

/** The platform guard, named for the routes that mount it. */
@Injectable()
export class InventoryThrottlerGuard extends BucketThrottlerGuard {}

function positiveInteger(
  raw: string | undefined,
  key: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}
