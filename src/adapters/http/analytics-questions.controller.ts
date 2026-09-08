import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  ASK_MODELLED_QUESTION_ROLES,
  AskModelledQuestionUseCase,
} from '../../application/semantic/ask-modelled-question.use-case';
import { day, periodFrom, type Period } from '../../domain/analytics/period';
import { DomainViolation } from '../../domain/errors';
import type { ModelledAnswer } from '../../domain/semantic/modelled-answer';
import { questionFrom } from '../../domain/semantic/question';
import { Access } from './access/access.decorator';
import { AnalyticsThrottlerGuard, OTHER_BUCKETS } from './analytics-throttling';
import { ModelledQuestionRequest } from './dto/analytics.dto';
import { actorOf } from './principal.middleware';

type ModelledQuestionResponse =
  | {
      readonly state: 'answered';
      readonly completeThrough: string;
      readonly servedFrom: 'prepared' | 'exported-objects';
      readonly rows: readonly Readonly<
        Record<string, string | number | null>
      >[];
    }
  | { readonly state: 'never-exported' };

/**
 * The one route a composed question arrives on.
 *
 * **`POST` for a read.** A composition carries lists, and a query string that
 * encodes them is a query string nobody can read in a log. Nothing about the
 * request changes state, which is why it answers `200` rather than `201`.
 *
 * **The same rate bucket as the analytical route**, not a second one. A
 * modelled question costs what an analytical one costs — it scans the same
 * objects — so counting it separately would hand one caller two budgets for the
 * same expense.
 *
 * **No `machines: true`**, for the reason the analytical route gives: admitting
 * keys would let an automated client decide how often that cost is paid. The
 * use case refuses them again, on the kind of caller rather than on the role.
 */
@Controller('tenants/:tenantId/analytics/questions')
@UseGuards(AnalyticsThrottlerGuard)
@SkipThrottle(OTHER_BUCKETS)
export class AnalyticsQuestionsController {
  constructor(private readonly questions: AskModelledQuestionUseCase) {}

  @Post()
  @HttpCode(200)
  @Access({ roles: ASK_MODELLED_QUESTION_ROLES })
  async ask(
    @Req() request: Request,
    @Body() body: ModelledQuestionRequest,
  ): Promise<ModelledQuestionResponse> {
    // Composed before the use case runs, and long before anything is signed:
    // an unknown name, an absent period and an over-long one are all the
    // caller's mistake and none of them reaches the model.
    const question = questionFrom({
      measures: body.measures,
      groupings: body.groupings ?? [],
      period: periodOf(body),
      by: body.by ?? 'recorded',
    });

    return present(
      await this.questions.execute({ actor: actorOf(request), question }),
    );
  }
}

/**
 * The caller's two days, as a period, with the domain's refusals turned into
 * the platform's — the same translation the movements route makes, and for the
 * same reason: `periodFrom` and `day` throw plain errors naming what was wrong,
 * and every one of those is the caller's mistake rather than a 500.
 */
function periodOf(body: ModelledQuestionRequest): Period {
  try {
    return periodFrom(day(body.from), day(body.to));
  } catch (error) {
    throw new DomainViolation({
      kind: 'validation',
      field: 'period',
      detail: error instanceof Error ? error.message : 'is not a period',
    });
  }
}

/**
 * The answer, as JSON, with its states intact.
 *
 * The union survives the edge rather than collapsing into an empty list: a
 * period with nothing in it and a tenant nothing has ever been carried for draw
 * the same chart, and only one of them means the data is missing. `servedFrom`
 * travels too, because an answer that cannot say where it came from makes the
 * preparation claim unfalsifiable from outside.
 */
function present(answer: ModelledAnswer): ModelledQuestionResponse {
  if (answer.state === 'never-exported') {
    return { state: 'never-exported' };
  }

  return {
    state: 'answered',
    completeThrough: answer.completeThrough.toISOString(),
    servedFrom: answer.servedFrom,
    rows: answer.rows.map((row) => row.values),
  };
}
