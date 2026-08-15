import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { ActorContext } from '../../application/actor-context';
import {
  PrincipalResolver,
  type PresentedCredential,
} from '../../application/principal-resolver';
import { opaqueSecret } from '../../domain/credential/secrets';
import { DomainViolation } from '../../domain/errors';
import { tenantId } from '../../domain/identifiers';

const ACTOR = Symbol('ACTOR');

interface RequestWithActor extends Request {
  [ACTOR]?: ActorContext;
}

/**
 * Attaches the resolved principal to the request, or attaches nothing.
 *
 * This replaces the middleware that read the principal from headers and
 * believed it. Nothing a caller sends can name who they are any more: the only
 * inputs are a bearer token and an API key, and both have to be verified before
 * they mean anything.
 */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  constructor(private readonly resolver: PrincipalResolver) {}

  async use(
    request: RequestWithActor,
    _response: Response,
    next: NextFunction,
  ): Promise<void> {
    const credential = presentedIn(request);
    if (credential !== null) {
      const actor = await this.resolver.resolve(credential);
      if (actor !== null) {
        request[ACTOR] = actor;
      }
    }
    next();
  }
}

/**
 * The tenant is read from the path rather than from the token, which is what
 * lets one person act in several tenants without re-authenticating.
 */
function presentedIn(request: Request): PresentedCredential | null {
  const authorization = header(request, 'authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice('bearer '.length).trim();
    if (token.length > 0) {
      return { scheme: 'access-token', token, tenantId: pathTenant(request) };
    }
  }

  const apiKey = header(request, 'x-api-key');
  if (apiKey) {
    return { scheme: 'api-key', secret: opaqueSecret(apiKey) };
  }
  return null;
}

/**
 * Matched from the URL rather than from route parameters: middleware runs
 * before Nest has matched a route, so `request.params` is not populated yet.
 *
 * The trailing slash is required. `/tenants/{id}` names a tenant an operator is
 * administering, while `/tenants/{id}/members` names the tenant someone is
 * acting *inside* — only the second is a tenant context. Without the
 * distinction an operator deactivating a tenant would be resolved as a member
 * of it and refused.
 */
function pathTenant(request: Request): ReturnType<typeof tenantId> | null {
  const match = /^\/tenants\/([^/?]+)\//.exec(request.originalUrl);
  return match ? tenantId(decodeURIComponent(match[1])) : null;
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

/**
 * The principal if one resolved, for the callers that have something to do
 * either way. Everything that needs an actor to proceed uses `actorOf`.
 */
export function resolvedActor(request: Request): ActorContext | null {
  return (request as RequestWithActor)[ACTOR] ?? null;
}

/**
 * An unresolved actor is reported as absence, not as a challenge. There is no
 * credential to challenge for that would tell the caller anything they are
 * entitled to know, and requirement 9.2 already wants every unauthorized
 * outcome to look the same.
 */
export function actorOf(request: Request): ActorContext {
  const actor = resolvedActor(request);
  if (!actor) {
    throw new DomainViolation(
      { kind: 'not-found' },
      'no credential was presented, or none that resolved to a principal',
    );
  }
  return actor;
}
