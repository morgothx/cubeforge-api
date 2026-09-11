import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  DESCRIBE_VOCABULARY_ROLES,
  DescribeVocabularyUseCase,
} from '../../application/semantic/describe-vocabulary.use-case';
import type { PublishedVocabulary } from '../../domain/semantic/published-vocabulary';
import { Access } from './access/access.decorator';
import { actorOf } from './principal.middleware';
import { everyBucketExcept } from './throttling-buckets';
import {
  VOCABULARY_BY_CALLER,
  VocabularyThrottlerGuard,
} from './vocabulary-throttling';

/**
 * What may be asked, before anything is.
 *
 * **Admitted exactly as a question is**, by the same role list and with no
 * machine credentials: a vocabulary is useful only to a caller who may ask, and
 * a route describing the questions should not admit callers the questions
 * refuse.
 *
 * **Its own allowance.** It reads no model and no exported data, so counting
 * it against the questions would spend a person's scarce allowance on
 * something free. It is limited at all because every route here is.
 *
 * **The body is the domain value, unmapped.** A presenter restating each field
 * would be a second place to add one, and the value was shaped for this wire
 * from the start.
 */
@Controller('tenants/:tenantId/analytics/vocabulary')
@UseGuards(VocabularyThrottlerGuard)
@SkipThrottle(everyBucketExcept(VOCABULARY_BY_CALLER))
export class AnalyticsVocabularyController {
  constructor(private readonly vocabulary: DescribeVocabularyUseCase) {}

  @Get()
  @Access({ roles: DESCRIBE_VOCABULARY_ROLES })
  describe(@Req() request: Request): PublishedVocabulary {
    return this.vocabulary.execute({ actor: actorOf(request) });
  }
}
