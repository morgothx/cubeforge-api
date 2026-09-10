import type { ThrottlerOptions } from '@nestjs/throttler';
import {
  analyticsThrottlerOptions,
  loadAnalyticsThrottlingConfig,
  type AnalyticsThrottlingConfig,
} from './analytics-throttling';
import { throttlerOptions } from './credential-throttling';
import {
  inventoryThrottlerOptions,
  loadInventoryThrottlingConfig,
} from './inventory-throttling';
import { loadThrottlingConfig } from './throttling.config';
import {
  loadVocabularyThrottlingConfig,
  vocabularyThrottlerOptions,
  type VocabularyThrottlingConfig,
} from './vocabulary-throttling';

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
  const questions = loadAnalyticsThrottlingConfig(env);
  const vocabulary = loadVocabularyThrottlingConfig(env);
  refuseVocabularyNotAbove(questions, vocabulary);

  return [
    ...throttlerOptions(loadThrottlingConfig(env)),
    ...inventoryThrottlerOptions(loadInventoryThrottlingConfig(env)),
    ...analyticsThrottlerOptions(questions),
    ...vocabularyThrottlerOptions(vocabulary),
  ];
}

/**
 * Describing what may be asked must stay easier to get than an answer.
 *
 * The two allowances are read from separate settings and meet only here, so
 * this is the one place that can notice an operator who tightened the
 * vocabulary below the questions — a dashboard that could ask but no longer
 * learn what to ask. Compared as rates, because the windows are configured
 * separately and twenty in two minutes is not more than ten in one.
 *
 * Cross-multiplied rather than divided, so the comparison is exact in
 * integers.
 */
function refuseVocabularyNotAbove(
  questions: AnalyticsThrottlingConfig,
  vocabulary: VocabularyThrottlingConfig,
): void {
  const vocabularyRate = vocabulary.requestsPerCaller * questions.windowSeconds;
  const questionRate = questions.questionsPerCaller * vocabulary.windowSeconds;

  if (vocabularyRate <= questionRate) {
    throw new Error(
      'ANALYTICS_VOCABULARY_REQUESTS_PER_CALLER per ANALYTICS_VOCABULARY_WINDOW_SECONDS ' +
        'must allow more requests than ANALYTICS_QUESTIONS_PER_CALLER per ' +
        'ANALYTICS_THROTTLE_WINDOW_SECONDS',
    );
  }
}
