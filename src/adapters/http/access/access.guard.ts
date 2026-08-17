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

    if ('person' in declaration) {
      // The only declaration that asks nothing about standing. Both kinds
      // below name a person, and requirement 3.1 admits a caller whether or
      // not they hold a membership or an operator record — so there is nothing
      // further to read, and no tenant transaction to open.
      //
      // A machine is refused because it names a credential rather than a
      // person. A tenant member is refused because their request named a
      // tenant, which makes it a different kind of request: the same human on
      // a path naming no tenant resolves to `person` and is admitted.
      if (actor.kind === 'person' || actor.kind === 'platform-operator') {
        return true;
      }
      throw refusal(
        `this route admits any person; this caller is a ${actor.kind}`,
      );
    }

    if (actor.kind === 'machine') {
      if (declaration.machines !== true) {
        // The key may well carry the role the route names. Holding the role is
        // not the question: reaching a route as a machine is a separate
        // admission a route has to make deliberately.
        throw refusal('this route does not admit machine callers');
      }
      if (!declaration.roles.includes(actor.role)) {
        throw refusal(
          `this key carries ${actor.role}, which this route does not name`,
        );
      }
      // A person's tenant comes from the path, so the two cannot disagree. A
      // machine's comes from its credential, so they can — and this comparison
      // is what keeps a key inside the tenant it was issued into.
      if (actor.tenantId !== tenantInPath(context)) {
        throw refusal('this key belongs to a tenant this path does not name');
      }
      return true;
    }

    if (actor.kind !== 'tenant-member') {
      // An operator is above every tenant and inside none of them.
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

/**
 * The tenant the request addressed, read from the matched route's parameter.
 *
 * A guard runs after routing, so `params` is populated and is the precise
 * source — unlike the middleware upstream, which runs before matching and has
 * to recognize the path with a pattern. A route that admits machines and names
 * no tenant has nothing to compare a key against, and returning `null` refuses
 * it.
 */
function tenantInPath(context: ExecutionContext): string | null {
  const { params } = context.switchToHttp().getRequest<Request>();
  const value: unknown = params.tenantId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function refusal(reason: string): DomainViolation {
  return new DomainViolation({ kind: 'not-found' }, reason);
}
