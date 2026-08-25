import { Inject, Injectable } from '@nestjs/common';
import type { LocationCode } from '../../domain/inventory/identifiers';
import type { ActorContext } from '../actor-context';
import type { Declaration } from '../ports/reference.repository';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { tenantActedIn } from '../tenant-authorization';

export interface DeclareLocationCommand {
  readonly actor: ActorContext;
  readonly code: LocationCode;
  readonly name: string;
}

/** The catalogue's twin, and idempotent for the same reason. */
@Injectable()
export class DeclareLocationUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenants: TenantScopedUnitOfWork,
  ) {}

  async execute(command: DeclareLocationCommand): Promise<Declaration> {
    const tenantId = tenantActedIn(command.actor);

    return this.tenants.runInTenant(tenantId, ({ locations }) =>
      locations.declare(command.code, { name: command.name }),
    );
  }
}
