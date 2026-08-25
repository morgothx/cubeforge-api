import { Inject, Injectable } from '@nestjs/common';
import type { Declaration } from '../ports/reference.repository';
import type { Sku } from '../../domain/inventory/identifiers';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import {
  authorizeCallerInTenant,
  tenantActedIn,
} from '../tenant-authorization';

export interface DeclareProductCommand {
  readonly actor: ActorContext;
  readonly sku: Sku;
  readonly name: string;
  readonly category: string | null;
}

/**
 * Declaring is idempotent by construction: the same declaration twice leaves
 * one product and reports the second as a replacement rather than as a
 * conflict.
 *
 * That is not politeness towards a careless caller. An upstream system
 * synchronises its whole catalogue on a schedule and sends every product every
 * time; a conflict on the second night would mean the integration works once.
 */
/** Declaring changes what a tenant tracks, so a viewer may not. */
export const DECLARE_PRODUCT_ROLES = [
  'admin',
  'editor',
] as const satisfies readonly Role[];

@Injectable()
export class DeclareProductUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenants: TenantScopedUnitOfWork,
  ) {}

  async execute(command: DeclareProductCommand): Promise<Declaration> {
    // The tenant comes from the caller, never from the payload, so "a caller in
    // tenant A declaring into tenant B" is not expressible rather than merely
    // refused.
    const tenantId = tenantActedIn(command.actor);

    return this.tenants.runInTenant(tenantId, async (repositories) => {
      await authorizeCallerInTenant(
        repositories,
        command.actor,
        DECLARE_PRODUCT_ROLES,
      );

      return repositories.products.declare(command.sku, {
        name: command.name,
        category: command.category,
      });
    });
  }
}
