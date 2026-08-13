import type { NextFunction, Request, Response } from 'express';
import type { ActorContext } from '../../application/actor-context';
import { DomainViolation } from '../../domain/errors';
import { personId, tenantId } from '../../domain/identifiers';

export const ACTOR = Symbol('ACTOR');

interface RequestWithActor extends Request {
  [ACTOR]?: ActorContext;
}

/**
 * Reads the acting principal from request headers, trusting them completely.
 *
 * This is a placeholder for authentication (feature 2) and nothing more. It is
 * a forgery machine: anyone can claim to be any person in any tenant. It exists
 * so the rest of the feature can be exercised end to end before credentials
 * exist, and feature 2 deletes it.
 *
 * `createActorContextMiddleware` refuses to build it in production rather than
 * quietly returning a no-op. A misconfiguration that leaves this out of the
 * pipeline is survivable; one that leaves it *in* is a total authentication
 * bypass, so the failure is made loud and early.
 */
export function createActorContextMiddleware(environment: string | undefined) {
  if (environment === 'production') {
    throw new Error(
      'the provisional actor middleware trusts request headers and must never be registered in production',
    );
  }

  return function actorContextMiddleware(
    request: RequestWithActor,
    _response: Response,
    next: NextFunction,
  ): void {
    const actor = readActor(request);
    if (actor) {
      request[ACTOR] = actor;
    }
    next();
  };
}

function readActor(request: Request): ActorContext | undefined {
  const kind = header(request, 'x-actor-kind');
  const person = header(request, 'x-person-id');
  const tenant = header(request, 'x-tenant-id');

  if (kind === 'platform-operator' && person) {
    return { kind: 'platform-operator', personId: personId(person) };
  }
  if (kind === 'tenant-member' && person && tenant) {
    return {
      kind: 'tenant-member',
      personId: personId(person),
      tenantId: tenantId(tenant),
    };
  }
  return undefined;
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

/**
 * An unresolved actor is reported as absence, not as a challenge. Until
 * feature 2 there is no credential to challenge for, and requirement 9.2
 * already wants every unauthorized outcome to look the same.
 */
export function actorOf(request: Request): ActorContext {
  const actor = (request as RequestWithActor)[ACTOR];
  if (!actor) {
    throw new DomainViolation({ kind: 'not-found' });
  }
  return actor;
}
