import {
  Catch,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import { correlationOf } from './correlation.middleware';

/**
 * What a caller is told when a question could not be answered.
 *
 * **The class of problem and nothing else** (6.3). The cause is an engine's or
 * a driver's wording, and that wording routinely carries the statement that
 * ran, the location of the data and occasionally a credential — so it is logged
 * and never serialised. The reason is a closed set of five words this
 * repository wrote itself, which is what makes it safe to return.
 *
 * Every one of them is 503 rather than 500. The distinction is real and worth
 * making to a client: 500 says this request was broken, 503 says the answer is
 * not available right now and the same request may work later, which is true of
 * a timeout, an unreachable store and a setting nobody has supplied yet.
 *
 * Filed against the request's correlation identifier (6.4), which is the only
 * thread joining this line to whatever else that request did.
 */
@Catch(AnalyticsUnavailable)
export class AnalyticsFailureFilter implements ExceptionFilter<AnalyticsUnavailable> {
  private readonly logger = new Logger(AnalyticsFailureFilter.name);

  catch(exception: AnalyticsUnavailable, host: ArgumentsHost): void {
    const http = host.switchToHttp();

    this.logger.error(
      `${correlationOf(http.getRequest<Request>())} analytics ${exception.reason}`,
      exception.cause instanceof Error ? exception.cause.stack : undefined,
    );

    http.getResponse<Response>().status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'the answer is unavailable',
      reason: exception.reason,
    });
  }
}
