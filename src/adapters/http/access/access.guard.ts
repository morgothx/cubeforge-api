import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../../../application/ports/tenant-scoped-unit-of-work';
import { authorizeInTenant } from '../../../application/tenant-authorization';
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
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenantScoped: TenantScopedUnitOfWork,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    if ('operator' in declaration) {
      // Read from the actor every time, never remembered between requests:
      // operator status lives in storage and the resolver consults it per
      // request, so withdrawing it takes effect at once rather than when a
      // token happens to expire.
      if (actor.kind !== 'platform-operator') {
        throw refusal(
          `this route is for operators; this caller is a ${actor.kind}`,
        );
      }
      return true;
    }

    if (actor.kind !== 'tenant-member') {
      // An operator is above every tenant and inside none of them; a machine is
      // handled by the pass that teaches this guard about `machines`. Until
      // then it is refused, which is the same answer it will get on any route
      // that does not admit it.
      throw refusal(
        `this route is for tenant members; this caller is a ${actor.kind}`,
      );
    }

    // The tenant comes from the request path — the middleware put it on the
    // actor — so "administrator of one tenant operating on another" is not
    // expressible here rather than merely rejected.
    //
    // A transaction of the guard's own, because the use case behind the route
    // has not opened one yet and owns the one it will. The two reads can differ
    // if a membership changes between them; the request is refused either way,
    // which is the direction that costs nothing.
    await this.tenantScoped.runInTenant(actor.tenantId, (repositories) =>
      authorizeInTenant(repositories, actor, declaration.roles),
    );
    return true;
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
