import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import type { TenantId } from '../../domain/identifiers';
import { deactivateTenant } from '../../domain/tenant/tenant.entity';
import type { ActorContext } from '../actor-context';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../ports/platform-unit-of-work';
import { requirePlatformOperator } from '../tenant-authorization';

export interface DeactivateTenantCommand {
  readonly actor: ActorContext;
  readonly tenantId: TenantId;
}

@Injectable()
export class DeactivateTenantUseCase {
  constructor(
    @Inject(PLATFORM_UNIT_OF_WORK)
    private readonly platform: PlatformUnitOfWork,
  ) {}

  async execute(command: DeactivateTenantCommand): Promise<void> {
    requirePlatformOperator(command.actor);

    await this.platform.runAsOperator(async ({ tenants }) => {
      const tenant = await tenants.findById(command.tenantId);
      if (tenant === null) {
        throw new DomainViolation({ kind: 'not-found' });
      }

      // Repeating the request is a no-op rather than a failure (2.4), which the
      // domain transition already expresses; the write below is then identical
      // in both cases.
      const deactivated = deactivateTenant(tenant);
      await tenants.updateStatus(deactivated.id, deactivated.status);
    });
  }
}
