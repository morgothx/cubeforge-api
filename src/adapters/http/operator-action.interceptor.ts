import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import { correlationOf } from './correlation.middleware';
import { resolvedActor } from './principal.middleware';

/**
 * Writes down which operator did what.
 *
 * Requirement 11.6 asks for operator actions to be recorded, and carrying the
 * person on the principal only makes that possible — nothing was writing it
 * anywhere. One interceptor covers every operator route, present and future,
 * which is the point: a rule applied per controller is a rule someone forgets
 * on the controller added next.
 *
 * Only operators are logged. Ordinary tenant traffic is the bulk of the volume
 * and is already scoped by the tenant in its path, while operator actions are
 * rare, unscoped, and the ones an incident review will ask about.
 */
@Injectable()
export class OperatorActionInterceptor implements NestInterceptor {
  private readonly log = new Logger('OperatorAction');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const actor = resolvedActor(request);
    if (actor?.kind !== 'platform-operator') {
      return next.handle();
    }

    // The identifier, never the address: an operator is a person, and 12.1
    // keeps personal data out of the log even when the person is staff.
    const who = `${correlationOf(request)} operator ${actor.personId} ${request.method} ${request.originalUrl}`;

    return next.handle().pipe(
      tap({
        // Refusals are recorded too. An operator action that was attempted and
        // denied is the more interesting half of an audit trail.
        next: () => this.log.log(`${who} succeeded`),
        error: (error: unknown) =>
          this.log.log(
            `${who} failed: ${error instanceof Error ? error.name : 'unknown error'}`,
          ),
      }),
    );
  }
}
