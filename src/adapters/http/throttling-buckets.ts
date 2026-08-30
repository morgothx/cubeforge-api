import { Injectable, Logger, type ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { correlationOf } from './correlation.middleware';
import { resolvedActor } from './principal.middleware';

/**
 * Every named bucket on the platform, in one list.
 *
 * `ThrottlerModule` is `@Global`: one registration holds every bucket, and a
 * throttled handler is counted by all of them unless it says otherwise. So each
 * route has to skip the buckets that are not its own — a sign-in route counted
 * by the inventory tracker, or an inventory route counted by a tracker that
 * reads an email out of a body it does not have, is a limit applied to a caller
 * it was never meant for.
 *
 * Those skip lists were written by hand, one per feature, each naming the
 * buckets that existed when it was written. **Adding the fifth bucket required
 * editing four of them**, and forgetting any one of the four would have been
 * invisible: the route keeps working, and simply spends somebody else's
 * allowance. Derived from one list instead, that mistake is not available.
 */
export const SIGN_IN_BY_ORIGIN = 'sign-in-origin';
export const SIGN_IN_BY_ADDRESS = 'sign-in-address';
export const REDEMPTION_BY_ORIGIN = 'redemption-origin';
export const INVENTORY_BY_CREDENTIAL = 'inventory-credential';
export const ANALYTICS_BY_CALLER = 'analytics-caller';

export const EVERY_BUCKET = [
  SIGN_IN_BY_ORIGIN,
  SIGN_IN_BY_ADDRESS,
  REDEMPTION_BY_ORIGIN,
  INVENTORY_BY_CREDENTIAL,
  ANALYTICS_BY_CALLER,
] as const;

/**
 * What a route passes to `@SkipThrottle`: every bucket except the ones it owns.
 *
 * A route may own more than one — sign-in is counted per address *and* per
 * origin — so this takes as many as it needs. A name that is not a registered
 * bucket is a typo that would otherwise silently skip nothing, so it is
 * refused here rather than discovered as an unexplained 429.
 */
export function everyBucketExcept(
  ...owned: readonly string[]
): Record<string, boolean> {
  for (const bucket of owned) {
    if (!(EVERY_BUCKET as readonly string[]).includes(bucket)) {
      throw new Error(`no such throttling bucket: ${bucket}`);
    }
  }

  return Object.fromEntries(
    EVERY_BUCKET.filter((bucket) => !owned.includes(bucket)).map((bucket) => [
      bucket,
      true,
    ]),
  );
}

/**
 * Which caller is asking, as a bucket key.
 *
 * Hashed for the same reason the credential throttler hashes an address: this
 * value reaches a storage key and, for a person, it identifies a human.
 *
 * A caller with no principal falls back to the network origin. It will be
 * refused by the guard a moment later anyway, and bucketing every anonymous
 * request together is what stops an unauthenticated flood from consuming the
 * allowance of whoever shares its address.
 */
export function callerOf(request: Request): string {
  const actor = resolvedActor(request);
  const identity =
    actor === null
      ? `origin:${request.ip ?? 'unknown'}`
      : actor.kind === 'machine'
        ? `key:${actor.apiKeyId}`
        : `person:${actor.personId}`;

  return createHash('sha256').update(identity).digest('hex');
}

/**
 * Refuses with 429 and says how long to wait, for any bucket counted per caller.
 *
 * The wait is the one thing a throttled caller has to be told: a client that
 * cannot tell "slow down" from "broken" will either give up or hammer.
 *
 * **The library's own header is not enough.** For a *named* bucket it emits
 * `Retry-After-<bucket>`, and no HTTP client in the world honours that — a
 * caller would have to know this platform's bucket names to find it. The plain
 * `Retry-After` is set here as well, which is the one an ordinary client, proxy
 * or retry library already understands.
 */
@Injectable()
export class BucketThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger(BucketThrottlerGuard.name);

  /**
   * One allowance per caller, across a whole feature.
   *
   * The stock key includes the controller and the handler, which would give a
   * caller the full limit *per route* — sixty reads and sixty writes and sixty
   * batches against a limit that says sixty. The bucket and the tracker are the
   * whole key here, so listing a catalogue spends the same allowance as
   * submitting a batch.
   *
   * Found by a test that exhausted the allowance with reads and then wrote
   * successfully. Nothing about the configuration looked wrong.
   */
  protected generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return `${name}-${tracker}`;
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const seconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    http.getResponse<Response>().setHeader('Retry-After', seconds);

    // The bucket key is a hash, so this groups a caller's requests for an
    // operator reading logs without naming the person or the key behind them.
    this.log.warn(
      `${correlationOf(request)} throttled: ${detail.limit} requests exhausted for bucket ${detail.key.slice(0, 12)}`,
    );
    return super.throwThrottlingException(context, detail);
  }
}
