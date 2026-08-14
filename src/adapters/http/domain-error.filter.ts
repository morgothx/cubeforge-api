import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  DomainViolation,
  describeDomainError,
  type DomainError,
} from '../../domain/errors';
import { correlationOf } from './correlation.middleware';

interface MappedResponse {
  readonly status: number;
  readonly body: { readonly message: string; readonly field?: string };
}

/**
 * The only place that knows both the domain error union and HTTP.
 *
 * Refusal and absence produce byte-identical responses. Requirement 9.2 is
 * explicit about why: a caller who could tell "you may not touch this" from
 * "this does not exist" could confirm that an identifier exists somewhere on
 * the platform, which is a cross-tenant disclosure through the error channel.
 * The distinction survives in the log line, where only operators see it.
 */
@Catch(DomainViolation)
export class DomainErrorFilter implements ExceptionFilter<DomainViolation> {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: DomainViolation, host: ArgumentsHost): void {
    const mapped = map(exception.error);
    const http = host.switchToHttp();

    // The cause and the correlation identifier are recorded here and appear in
    // no response (12.2). `reason` is the diagnosis the use case attached; the
    // kind alone would say `not-found` for an unknown address, a wrong password
    // and an expired setup token alike, which is useful to a caller and useless
    // to whoever has to explain what happened.
    this.logger.warn(
      `${correlationOf(http.getRequest<Request>())} ${exception.error.kind}: ${
        exception.reason ?? describeDomainError(exception.error)
      }`,
    );

    http.getResponse<Response>().status(mapped.status).json({
      statusCode: mapped.status,
      message: mapped.body.message,
      field: mapped.body.field,
    });
  }
}

const NOT_FOUND: MappedResponse = {
  status: HttpStatus.NOT_FOUND,
  body: { message: 'the requested record does not exist' },
};

/**
 * Exhaustive by construction: adding a member to the union without mapping it
 * fails the build rather than falling through to a default status.
 */
function map(error: DomainError): MappedResponse {
  switch (error.kind) {
    case 'validation':
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          message: describeDomainError(error),
          field: error.field,
        },
      };
    case 'invalid-role':
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { message: describeDomainError(error), field: 'role' },
      };
    case 'tenant-name-taken':
      return {
        status: HttpStatus.CONFLICT,
        body: { message: describeDomainError(error), field: 'name' },
      };
    case 'already-a-member':
      return {
        status: HttpStatus.CONFLICT,
        body: { message: describeDomainError(error), field: 'email' },
      };
    case 'last-administrator':
      return {
        status: HttpStatus.CONFLICT,
        body: { message: describeDomainError(error) },
      };
    // Both, identically, and on purpose. See the note above.
    case 'not-found':
    case 'forbidden':
      return NOT_FOUND;
    default:
      return unreachable(error);
  }
}

function unreachable(value: never): never {
  throw new Error(`unmapped domain error: ${JSON.stringify(value)}`);
}
