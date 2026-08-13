import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import { createTenant, type Tenant } from '../../domain/tenant/tenant.entity';
import type { ActorContext } from '../actor-context';
import { CLOCK, type Clock } from '../ports/clock';
import {
  IDENTIFIER_GENERATOR,
  type IdentifierGenerator,
} from '../ports/identifier-generator';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../ports/platform-unit-of-work';
import { requirePlatformOperator } from '../tenant-authorization';

export interface ProvisionTenantCommand {
  readonly actor: ActorContext;
  readonly name: string;
}

@Injectable()
export class ProvisionTenantUseCase {
  constructor(
    @Inject(PLATFORM_UNIT_OF_WORK)
    private readonly platform: PlatformUnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTIFIER_GENERATOR)
    private readonly identifiers: IdentifierGenerator,
  ) {}

  async execute(command: ProvisionTenantCommand): Promise<Tenant> {
    requirePlatformOperator(command.actor);

    if (command.name.trim().length === 0) {
      throw new DomainViolation({
        kind: 'validation',
        field: 'name',
        detail: 'must not be blank',
      });
    }

    const tenant = createTenant({
      id: this.identifiers.tenantId(),
      name: command.name,
      createdAt: this.clock.now(),
    });

    // Uniqueness is left to the store rather than checked first: a read
    // followed by an insert is a race, and the constraint answers correctly
    // under concurrency without one.
    await this.platform.runAsOperator(({ tenants }) => tenants.insert(tenant));

    return tenant;
  }
}
