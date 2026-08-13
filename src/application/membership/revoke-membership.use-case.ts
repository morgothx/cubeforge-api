import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import type { MembershipId } from '../../domain/identifiers';
import { revokeMembership } from '../../domain/membership/membership.entity';
import { assertTenantRetainsAdministrator } from '../../domain/tenant/tenant-administration.policy';
import type { ActorContext } from '../actor-context';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { authorizeInTenant, tenantOf } from '../tenant-authorization';

export interface RevokeMembershipCommand {
  readonly actor: ActorContext;
  readonly membershipId: MembershipId;
}

@Injectable()
export class RevokeMembershipUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
  ) {}

  async execute(command: RevokeMembershipCommand): Promise<void> {
    return this.unitOfWork.runInTenant(
      tenantOf(command.actor),
      async (repositories) => {
        await authorizeInTenant(repositories, command.actor, ['admin']);

        const membership = await repositories.memberships.findById(
          command.membershipId,
        );
        if (membership === null) {
          throw new DomainViolation({ kind: 'not-found' });
        }

        // An already revoked membership removes no administrator, so repeating
        // the request neither trips the invariant nor changes anything (6.1).
        assertTenantRetainsAdministrator({
          activeAdministratorCount:
            await repositories.memberships.countActiveAdministrators(),
          changeRemovesAnAdministrator:
            membership.status === 'active' && membership.role === 'admin',
        });

        const revoked = revokeMembership(membership);
        await repositories.memberships.updateStatus(revoked.id, revoked.status);
      },
    );
  }
}
