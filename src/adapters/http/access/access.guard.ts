import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainViolation } from '../../../domain/errors';
import { resolvedActor } from '../principal.middleware';
import { ACCESS_DECLARATION, type AccessDeclaration } from './access.decorator';

/**
 * Refuses a request before the route behind it runs, according to what that
 * route declares.
 *
 * Registered globally, so the route nobody thought about is covered by the same
 * rule as the route everybody reviewed. That is the point of the whole feature:
 * an unprotected endpoint should take a decision to create, not a lapse.
 *
 * Every refusal is an absence. A caller learns that the thing they addressed is
 * not there, and nothing about whether it exists, whether they were close, or
 * what they would have needed — the reason goes to the log instead.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const declaration = this.declarationFor(context);
    if (declaration === undefined) {
      throw refusal('this route declares no access');
    }

    if ('public' in declaration) {
      return true;
    }

    const actor = resolvedActor(context.switchToHttp().getRequest<Request>());
    if (actor === null) {
      throw refusal('this route needs a principal and none was resolved');
    }

    // Everything the guard has not yet learned to judge is refused rather than
    // admitted. Passes still to come teach it the operator and role cases; a
    // half-built guard that let through what it could not evaluate would be
    // worse than no guard, because it would look like one.
    throw refusal(
      `this declaration is not yet enforced: ${JSON.stringify(declaration)}`,
    );
  }

  /**
   * Handler first, controller second: a class-wide declaration is a default,
   * and reading it the other way round would let a permissive controller
   * outrank a method that restricted itself.
   */
  private declarationFor(
    context: ExecutionContext,
  ): AccessDeclaration | undefined {
    return this.reflector.getAllAndOverride<AccessDeclaration>(
      ACCESS_DECLARATION,
      [context.getHandler(), context.getClass()],
    );
  }
}

function refusal(reason: string): DomainViolation {
  return new DomainViolation({ kind: 'not-found' }, reason);
}
