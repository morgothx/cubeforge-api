import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const CORRELATION_ID = Symbol('CORRELATION_ID');

/** The header a caller may use to continue a trace that started upstream. */
export const CORRELATION_HEADER = 'x-correlation-id';

interface RequestWithCorrelation extends Request {
  [CORRELATION_ID]?: string;
}

/**
 * Every request gets an identifier, and it is echoed back.
 *
 * An inbound one is honoured so a trace that began at an API gateway or in the
 * dashboard continues here rather than restarting — but only after it is
 * checked, because the value goes into log lines and a caller must not be able
 * to write newlines, escape codes or a megabyte into them. Anything unusable is
 * replaced rather than rejected: the request itself is fine, only its label was
 * not.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(
    request: RequestWithCorrelation,
    response: Response,
    next: NextFunction,
  ): void {
    const id = acceptable(request.headers[CORRELATION_HEADER]) ?? randomUUID();
    request[CORRELATION_ID] = id;
    response.setHeader(CORRELATION_HEADER, id);
    next();
  }
}

/** Printable, punctuation-free and short enough to belong on one line. */
const USABLE = /^[A-Za-z0-9._-]{8,128}$/;

function acceptable(value: string | string[] | undefined): string | null {
  const single = Array.isArray(value) ? value[0] : value;
  const trimmed = single?.trim() ?? '';
  return USABLE.test(trimmed) ? trimmed : null;
}

/**
 * The identifier for the request being handled, or a marker that the middleware
 * did not run. Absence is reported rather than invented: a log line claiming a
 * correlation identifier that corresponds to no request is worse than one
 * admitting it has none.
 */
export function correlationOf(request: Request): string {
  return (request as RequestWithCorrelation)[CORRELATION_ID] ?? 'uncorrelated';
}
