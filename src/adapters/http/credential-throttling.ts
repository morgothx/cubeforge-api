import { Injectable, Logger, type ExecutionContext } from '@nestjs/common';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerOptions,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { correlationOf } from './correlation.middleware';
import type { ThrottlingConfig } from './throttling.config';

/**
 * The named buckets, referred to by name in `@SkipThrottle`.
 *
 * Three rather than two, because signing in and redeeming a setup token are
 * counted separately even though both count by origin: they are different
 * operations with different tolerances, and sharing a bucket would let a burst
 * of one lock out the other.
 */
export const SIGN_IN_BY_ORIGIN = 'sign-in-origin';
export const SIGN_IN_BY_ADDRESS = 'sign-in-address';
export const REDEMPTION_BY_ORIGIN = 'redemption-origin';

/**
 * Counting by origin and by address, because either one alone is avoidable.
 *
 * Counting per origin does nothing against a guesser with a botnet, and
 * counting per address does nothing against someone spraying one common
 * password across many addresses. Together they bound both shapes of attack,
 * and neither one bounds an ordinary person mistyping their own password.
 *
 * The window and the cooling period are separate: attempts are counted over the
 * window, and exceeding the count costs the caller the cooling period, which is
 * the longer of the two.
 */
export function throttlerOptions(config: ThrottlingConfig): ThrottlerOptions[] {
  const window = {
    ttl: config.windowSeconds * 1000,
    blockDuration: config.cooldownSeconds * 1000,
  };

  return [
    {
      ...window,
      name: SIGN_IN_BY_ORIGIN,
      limit: config.signInAttemptsPerOrigin,
      getTracker: (request: Record<string, unknown>) => originOf(request),
    },
    {
      ...window,
      name: SIGN_IN_BY_ADDRESS,
      limit: config.signInAttemptsPerAddress,
      getTracker: (request: Record<string, unknown>) => addressOf(request),
    },
    {
      ...window,
      name: REDEMPTION_BY_ORIGIN,
      limit: config.redemptionsPerOrigin,
      getTracker: (request: Record<string, unknown>) => originOf(request),
    },
  ];
}

/**
 * Guards run before pipes, so the body here is whatever was sent rather than a
 * validated payload — hence the shape check instead of a cast.
 *
 * The address is folded to lower case so that `Ann@example.com` and
 * `ann@example.com` share a bucket, and then hashed, because this value ends up
 * in a storage key and an email address is the one piece of personal data this
 * feature handles. A caller who presents no address at all is counted by
 * origin, so an absent field is not a way out of the bucket.
 */
function addressOf(request: Record<string, unknown>): string {
  const body: unknown = request.body;
  const email =
    typeof body === 'object' && body !== null && 'email' in body
      ? body.email
      : undefined;

  if (typeof email !== 'string' || email.trim().length === 0) {
    return originOf(request);
  }
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * `request.ip`, which is the socket address unless Express is told to trust a
 * proxy. Behind API Gateway that has to be configured deliberately: trusting
 * `X-Forwarded-For` without knowing how many proxies sit in front means letting
 * a caller prepend whatever origin they like and empty their own bucket.
 */
function originOf(request: Record<string, unknown>): string {
  const ip: unknown = request.ip;
  return typeof ip === 'string' && ip.length > 0 ? ip : 'unknown-origin';
}

/**
 * The stock guard, with the refusal written down.
 *
 * Throttling is the one authentication outcome that must be distinguishable —
 * a caller has to know to wait — so 429 is deliberate where every other failure
 * is 404. What must *not* differ is anything about the address behind it: the
 * log records which limit was reached and for which request, never the tracker,
 * which is a fingerprint of an email address.
 */
@Injectable()
export class CredentialThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger(CredentialThrottlerGuard.name);

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<Request>();
    // The key is a hash of the tracker, so it groups repeated attempts for an
    // operator without naming the address behind them.
    this.log.warn(
      `${correlationOf(request)} throttled: ${detail.limit} attempts exhausted for bucket ${detail.key.slice(0, 12)}`,
    );
    return super.throwThrottlingException(context, detail);
  }
}
