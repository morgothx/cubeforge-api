import { Injectable } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  ANALYTICS_BY_CALLER,
  BucketThrottlerGuard,
  callerOf,
  everyBucketExcept,
} from './throttling-buckets';

export { ANALYTICS_BY_CALLER };

/** Every bucket an analytical route must not be counted by. */
export const OTHER_BUCKETS = everyBucketExcept(ANALYTICS_BY_CALLER);

export interface AnalyticsThrottlingConfig {
  readonly windowSeconds: number;
  /**
   * Questions per caller per window.
   *
   * Deliberately far below the inventory allowance, and the reason is what a
   * request costs rather than what a caller deserves. An inventory read is one
   * indexed query; an analytical question scans objects, is billed by the bytes
   * it reads and can take tens of seconds. Ten a minute is more than a person
   * watching a dashboard produces and well short of what a loop would.
   */
  readonly questionsPerCaller: number;
}

const BASELINE: AnalyticsThrottlingConfig = {
  windowSeconds: 60,
  questionsPerCaller: 10,
};

type Env = Record<string, string | undefined>;

export function loadAnalyticsThrottlingConfig(
  env: Env,
): AnalyticsThrottlingConfig {
  return {
    windowSeconds: positiveInteger(
      env.ANALYTICS_THROTTLE_WINDOW_SECONDS,
      'ANALYTICS_THROTTLE_WINDOW_SECONDS',
      BASELINE.windowSeconds,
    ),
    questionsPerCaller: positiveInteger(
      env.ANALYTICS_QUESTIONS_PER_CALLER,
      'ANALYTICS_QUESTIONS_PER_CALLER',
      BASELINE.questionsPerCaller,
    ),
  };
}

/**
 * The analytics bucket, counted **per caller**.
 *
 * Not per tenant: two people on one dashboard are two callers, and letting an
 * eager one silence the other would make a colleague's refresh button
 * indistinguishable from an outage. Machines never reach these routes at all,
 * so unlike the inventory bucket there is no key to count.
 */
export function analyticsThrottlerOptions(
  config: AnalyticsThrottlingConfig,
): ThrottlerOptions[] {
  return [
    {
      name: ANALYTICS_BY_CALLER,
      ttl: config.windowSeconds * 1000,
      limit: config.questionsPerCaller,
      getTracker: (request: Record<string, unknown>) =>
        callerOf(request as unknown as Request),
    },
  ];
}

/** The platform guard, named for the routes that mount it. */
@Injectable()
export class AnalyticsThrottlerGuard extends BucketThrottlerGuard {}

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
