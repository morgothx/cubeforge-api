import { Inject, Injectable } from '@nestjs/common';
import type { Tenant } from '../../domain/tenant/tenant.entity';
import type { ActorContext } from '../actor-context';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../ports/platform-unit-of-work';
import { requirePlatformOperator } from '../tenant-authorization';

export interface ListTenantsQuery {
  readonly actor: ActorContext;
}

/**
 * Requirement 3.3 — no indication of which people belong to a tenant — needs no
 * filtering here: a `Tenant` carries no membership data, and the operator holds
 * no grant on `memberships` to obtain any.
 */
@Injectable()
export class ListTenantsUseCase {
  constructor(
    @Inject(PLATFORM_UNIT_OF_WORK)
    private readonly platform: PlatformUnitOfWork,
  ) {}

  // `async` even though nothing is awaited before the first call: a use case
  // must reject rather than throw synchronously, so every caller can handle
  // failure one way.
  async execute(query: ListTenantsQuery): Promise<Tenant[]> {
    requirePlatformOperator(query.actor);
    return this.platform.runAsOperator(({ tenants }) => tenants.list());
  }
}
