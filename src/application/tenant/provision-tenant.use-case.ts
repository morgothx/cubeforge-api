import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import { emailAddress } from '../../domain/identifiers';
import { createMembership } from '../../domain/membership/membership.entity';
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
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { requirePlatformOperator } from '../tenant-authorization';

export interface ProvisionTenantCommand {
  readonly actor: ActorContext;
  readonly name: string;
  /** The person who will administer it. A tenant nobody can administer is unusable. */
  readonly administratorEmail: string;
}

@Injectable()
export class ProvisionTenantUseCase {
  constructor(
    @Inject(PLATFORM_UNIT_OF_WORK)
    private readonly platform: PlatformUnitOfWork,
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenantScoped: TenantScopedUnitOfWork,
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

    // Parsed before anything is written, so a malformed address cannot leave a
    // tenant behind.
    const administratorEmail = this.parseEmail(command.administratorEmail);

    const createdAt = this.clock.now();
    const tenant = createTenant({
      id: this.identifiers.tenantId(),
      name: command.name,
      createdAt,
    });

    // Uniqueness is left to the store rather than checked first: a read
    // followed by an insert is a race, and the constraint answers correctly
    // under concurrency without one.
    //
    // The tenant goes first because the membership refers to it, which also
    // satisfies requirement 8.2: a name already taken fails here, before
    // anything else has run.
    await this.platform.runAsOperator(({ tenants }) => tenants.insert(tenant));

    try {
      await this.tenantScoped.runInTenant(tenant.id, async (repositories) => {
        // The same resolve-or-create used when adding any member, so the two
        // address cases perform identical work and produce identical responses.
        const personId = await repositories.people.findOrCreateByEmail({
          candidateId: this.identifiers.personId(),
          email: administratorEmail,
          createdAt,
        });

        await repositories.memberships.insert(
          createMembership({
            id: this.identifiers.membershipId(),
            tenantId: tenant.id,
            personId,
            role: 'admin',
            createdAt,
          }),
        );
      });
    } catch (error) {
      // The two steps run on different connections, so they are two
      // transactions and cannot roll back together. Leaving a tenant nobody can
      // administer would recreate the very gap this change closes, so the
      // tenant is retired instead.
      await this.platform.runAsOperator(({ tenants }) =>
        tenants.updateStatus(tenant.id, 'inactive'),
      );
      throw error;
    }

    return tenant;
  }

  private parseEmail(value: string) {
    try {
      return emailAddress(value);
    } catch (error) {
      throw new DomainViolation({
        kind: 'validation',
        field: 'administratorEmail',
        detail: error instanceof Error ? error.message : 'is invalid',
      });
    }
  }
}
