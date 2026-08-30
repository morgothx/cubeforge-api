import type { ThrottlerOptions } from '@nestjs/throttler';
import {
  analyticsThrottlerOptions,
  loadAnalyticsThrottlingConfig,
} from './analytics-throttling';
import { throttlerOptions } from './credential-throttling';
import {
  inventoryThrottlerOptions,
  loadInventoryThrottlingConfig,
} from './inventory-throttling';
import { loadThrottlingConfig } from './throttling.config';

type Env = Record<string, string | undefined>;

/**
 * Every bucket the platform registers, composed once.
 *
 * `ThrottlerModule.forRoot` is called in exactly one place because a second
 * call would not add buckets, it would replace them — and the limits that
 * disappeared would take no test with them. Composing the list here rather than
 * inline in `AppModule` is what lets `throttling-buckets.spec.ts` check that
 * every bucket a route skips is a bucket something actually registers: a name
 * declared and never registered would be skipped everywhere and count nothing.
 */
export function platformThrottlerOptions(env: Env): ThrottlerOptions[] {
  return [
    ...throttlerOptions(loadThrottlingConfig(env)),
    ...inventoryThrottlerOptions(loadInventoryThrottlingConfig(env)),
    ...analyticsThrottlerOptions(loadAnalyticsThrottlingConfig(env)),
  ];
}
