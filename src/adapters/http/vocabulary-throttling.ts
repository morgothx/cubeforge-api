import { Injectable } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  BucketThrottlerGuard,
  VOCABULARY_BY_CALLER,
  callerOf,
} from './throttling-buckets';

export { VOCABULARY_BY_CALLER };

export interface VocabularyThrottlingConfig {
  readonly windowSeconds: number;
  /**
   * Requests for the vocabulary per caller per window.
   *
   * Far above the question allowance, and the reason is cost rather than
   * generosity. Describing what may be asked reads no model and no exported
   * data; it answers from declarations held in memory. Counting it against the
   * questions would spend a tenth of a person's minute every time a dashboard
   * opened its explorer, on something that costs nothing to answer. It is
   * limited at all because every route on this platform is.
   */
  readonly requestsPerCaller: number;
}

const BASELINE: VocabularyThrottlingConfig = {
  windowSeconds: 60,
  requestsPerCaller: 60,
};

type Env = Record<string, string | undefined>;

export function loadVocabularyThrottlingConfig(
  env: Env,
): VocabularyThrottlingConfig {
  return {
    windowSeconds: positiveInteger(
      env.ANALYTICS_VOCABULARY_WINDOW_SECONDS,
      'ANALYTICS_VOCABULARY_WINDOW_SECONDS',
      BASELINE.windowSeconds,
    ),
    requestsPerCaller: positiveInteger(
      env.ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER,
      'ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER',
      BASELINE.requestsPerCaller,
    ),
  };
}

/**
 * The vocabulary bucket, counted **per caller**, with the tracker the question
 * bucket uses — so a person is one allowance across every tenant they can
 * reach, as they are for questions.
 */
export function vocabularyThrottlerOptions(
  config: VocabularyThrottlingConfig,
): ThrottlerOptions[] {
  return [
    {
      name: VOCABULARY_BY_CALLER,
      ttl: config.windowSeconds * 1000,
      limit: config.requestsPerCaller,
      getTracker: (request: Record<string, unknown>) =>
        callerOf(request as unknown as Request),
    },
  ];
}

/** The platform guard, named for the route that mounts it. */
@Injectable()
export class VocabularyThrottlerGuard extends BucketThrottlerGuard {}

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
