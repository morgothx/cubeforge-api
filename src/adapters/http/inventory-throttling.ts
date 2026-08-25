import { Injectable, Logger, type ExecutionContext } from '@nestjs/common';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerOptions,
} from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { correlationOf } from './correlation.middleware';
import {
  REDEMPTION_BY_ORIGIN,
  SIGN_IN_BY_ADDRESS,
  SIGN_IN_BY_ORIGIN,
} from './credential-throttling';
import { resolvedActor } from './principal.middleware';

/** The bucket name, referred to by `@SkipThrottle` elsewhere. */
export const INVENTORY_BY_CREDENTIAL = 'inventory-credential';

/**
 * Every bucket that is not this feature's.
 *
 * `ThrottlerModule` is `@Global`, so one registration holds every bucket and a
 * throttled handler is counted by all of them unless it says otherwise. An
 * inventory route counted by `sign-in-address` would be counted by a tracker
 * that reads an email out of a body it does not have.
 *
 * Written as one exported object rather than repeated per handler, so adding a
 * bucket to the platform is one edit here instead of one per route.
 */
export const OTHER_BUCKETS = {
  [SIGN_IN_BY_ORIGIN]: true,
  [SIGN_IN_BY_ADDRESS]: true,
  [REDEMPTION_BY_ORIGIN]: true,
} as const;

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
        credentialOf(request as unknown as Request),
    },
  ];
}

/**
 * Which credential is asking.
 *
 * Hashed for the same reason the credential throttler hashes an address: this
 * value reaches a storage key and, for a person, it is an identifier of a human.
 *
 * A caller with no principal falls back to the network origin. It will be
 * refused by the guard a moment later anyway, and bucketing every anonymous
 * request together is what stops an unauthenticated flood from consuming the
 * allowance of whoever shares its address.
 */
function credentialOf(request: Request): string {
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
 * Refuses with 429 and says how long to wait.
 *
 * The wait is the one thing a throttled caller has to be told: an integration
 * that cannot tell "slow down" from "broken" will either give up or hammer.
 *
 * **The library's own header is not enough.** For a *named* bucket it emits
 * `Retry-After-inventory-credential`, and no HTTP client in the world honours
 * that — a caller would have to know this platform's bucket names to find it.
 * The plain `Retry-After` is set here as well, which is the one an ordinary
 * client, proxy or retry library already understands.
 */
@Injectable()
export class InventoryThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger(InventoryThrottlerGuard.name);

  /**
   * One allowance per credential, across the whole feature.
   *
   * The stock key includes the controller and the handler, which would give a
   * caller sixty requests *per route* — sixty reads and sixty writes and sixty
   * batches, four hundred and twenty a minute against a limit that says sixty.
   * The bucket and the tracker are the whole key here, so listing the catalogue
   * spends the same allowance as submitting a batch.
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
      `${correlationOf(request)} throttled: ${detail.limit} inventory requests exhausted for bucket ${detail.key.slice(0, 12)}`,
    );
    return super.throwThrottlingException(context, detail);
  }
}

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
