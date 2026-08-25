import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { MovementOutcome } from '../../application/inventory/record-movements.use-case';
import { RecordMovementsUseCase } from '../../application/inventory/record-movements.use-case';
import { SkipThrottle } from '@nestjs/throttler';
import { Access } from './access/access.decorator';
import { InventoryThrottlerGuard, OTHER_BUCKETS } from './inventory-throttling';
import {
  MovementRow,
  RecordMovementsBatchRequest,
  type MovementOutcomeResponse,
  type RecordMovementsResponse,
} from './dto/inventory-movements.dto';
import { actorOf } from './principal.middleware';

/**
 * Recording what happened to stock.
 *
 * **Per-row rejections never travel through the error filter.** A thrown
 * domain error is the whole response — that is what the filter is for — and a
 * batch outcome is one answer per row. So the report is a value the use case
 * returns and this controller renders, and the filter keeps the failures that
 * really are the request's: no credential, the wrong role, a body that is not
 * a body, a batch too large.
 *
 * Both routes answer 200. A partially applied batch is not a failure, and 207
 * would say the caller must inspect the body — which is true of every response
 * here, including the one where nothing was wrong.
 */
@Controller('tenants/:tenantId/inventory/movements')
@UseGuards(InventoryThrottlerGuard)
@SkipThrottle(OTHER_BUCKETS)
export class InventoryMovementsController {
  constructor(private readonly record: RecordMovementsUseCase) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Access({ roles: ['admin', 'editor'], machines: true })
  async recordOne(
    @Req() request: Request,
    @Body() body: MovementRow,
  ): Promise<MovementOutcomeResponse> {
    // A batch of one, so the two routes cannot drift apart. There is no second
    // path through the rules, and therefore no second path to keep correct.
    const report = await this.record.execute({
      actor: actorOf(request),
      movements: [body],
    });

    return rendered(report.outcomes[0]);
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @Access({ roles: ['admin', 'editor'], machines: true })
  async recordMany(
    @Req() request: Request,
    @Body() body: RecordMovementsBatchRequest,
  ): Promise<RecordMovementsResponse> {
    const report = await this.record.execute({
      actor: actorOf(request),
      movements: body.movements,
    });

    return {
      recorded: report.recorded,
      alreadyRecorded: report.alreadyRecorded,
      rejected: report.rejected,
      outcomes: report.outcomes.map(rendered),
    };
  }
}

/**
 * One outcome, as a caller reads it.
 *
 * `reason` appears only on a rejection, and it is a member of the domain's
 * closed set — a caller can act on it programmatically rather than by matching
 * prose, and nothing here mentions a record the caller may not read.
 */
function rendered(outcome: MovementOutcome): MovementOutcomeResponse {
  return outcome.status === 'rejected'
    ? {
        status: outcome.status,
        externalId: outcome.externalId,
        reason: outcome.reason,
      }
    : { status: outcome.status, externalId: outcome.externalId };
}
