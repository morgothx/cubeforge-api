import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  READ_MOVEMENT_HISTORY_ROLES,
  ReadMovementHistoryUseCase,
} from '../../application/analytics/read-movement-history.use-case';
import type {
  AnalyticalAnswer,
  MovementsOnDayEntry,
} from '../../domain/analytics/answer';
import { day, periodFrom, type Period } from '../../domain/analytics/period';
import { DomainViolation } from '../../domain/errors';
import { Access } from './access/access.decorator';
import { AnalyticsThrottlerGuard, OTHER_BUCKETS } from './analytics-throttling';
import { MovementHistoryRequest } from './dto/analytics.dto';
import { actorOf } from './principal.middleware';

type MovementHistoryResponse =
  | {
      readonly state: 'answered';
      readonly completeThrough: string;
      readonly entries: readonly {
        readonly day: string;
        readonly kind: string;
        readonly quantity: number;
      }[];
    }
  | { readonly state: 'never-exported' };

/**
 * The one analytical route, and deliberately one.
 *
 * A full analytical HTTP surface would be work built to be deleted: the
 * semantic layer of step 8 consumes the port directly and replaces anything
 * shaped like this. What a route buys that a use-case test cannot is the
 * isolation surviving a **real request** — a tenant taken from the path, a
 * membership resolved from a credential, a guard in between — which is the one
 * property this feature exists to demonstrate.
 *
 * So the question with the period rules is the one exposed, because refusing an
 * absent or over-long period is observable at the edge. What is on hand is
 * answered by the port and proven at the use-case and adapter levels, which is
 * where Cube will meet it anyway.
 *
 * No `machines: true`. An analytical question is expensive and admitting keys
 * would let an automated client decide how often that cost is paid; the use
 * case refuses them again, on the kind of caller rather than on the role.
 */
@Controller('tenants/:tenantId/analytics/movements')
@UseGuards(AnalyticsThrottlerGuard)
@SkipThrottle(OTHER_BUCKETS)
export class AnalyticsController {
  constructor(private readonly history: ReadMovementHistoryUseCase) {}

  @Get()
  @Access({ roles: READ_MOVEMENT_HISTORY_ROLES })
  async index(
    @Req() request: Request,
    @Query() query: MovementHistoryRequest,
  ): Promise<MovementHistoryResponse> {
    // Built before the use case is called, so a period the platform will not
    // answer never reaches the engine (5.4).
    const period = periodOf(query);

    return present(
      await this.history.execute({ actor: actorOf(request), period }),
    );
  }
}

/**
 * The caller's two days, as a period, with the domain's refusals turned into
 * the platform's.
 *
 * `periodFrom` and `day` throw plain errors naming what was wrong — a date that
 * is not on the calendar, an end before its start, a span beyond the longest
 * the platform answers, which 1.5 requires it to state. Every one of those is
 * the caller's mistake, so they arrive as a validation refusal rather than as
 * the 500 an unrecognised error would become. Nothing in those messages names a
 * tenant, a record or a location.
 */
function periodOf(query: MovementHistoryRequest): Period {
  try {
    return periodFrom(day(query.from), day(query.to));
  } catch (error) {
    throw new DomainViolation({
      kind: 'validation',
      field: 'period',
      detail: error instanceof Error ? error.message : 'is not a period',
    });
  }
}

/**
 * The answer, as JSON, with its three states intact.
 *
 * The union survives the edge rather than collapsing into an empty list: a
 * period with nothing in it and a tenant nothing has ever been carried for draw
 * the same chart, and only one of them means the data is missing (3.3). A
 * client that had to infer the difference from an empty array would infer it
 * wrong.
 */
function present(
  answer: AnalyticalAnswer<MovementsOnDayEntry>,
): MovementHistoryResponse {
  if (answer.state === 'never-exported') {
    return { state: 'never-exported' };
  }

  return {
    state: 'answered',
    completeThrough: answer.completeThrough.toISOString(),
    entries: answer.entries.map((entry) => ({
      day: entry.day,
      kind: entry.kind,
      quantity: entry.quantity,
    })),
  };
}
