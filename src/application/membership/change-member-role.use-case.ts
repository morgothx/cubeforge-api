import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import type { MembershipId } from '../../domain/identifiers';
import { parseRole, type Role } from '../../domain/membership/role';
import { assertTenantRetainsAdministrator } from '../../domain/tenant/tenant-administration.policy';
import type { ActorContext } from '../actor-context';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { authorizeInTenant, tenantOf } from '../tenant-authorization';

export interface ChangeMemberRoleCommand {
  readonly actor: ActorContext;
  readonly membershipId: MembershipId;
  readonly role: string;
}

@Injectable()
export class ChangeMemberRoleUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
  ) {}

  async execute(command: ChangeMemberRoleCommand): Promise<void> {
    return this.unitOfWork.runInTenant(
      tenantOf(command.actor),
      async (repositories) => {
        await authorizeInTenant(repositories, command.actor, ['admin']);

        const parsed = parseRole(command.role);
        if (!parsed.ok) {
          throw new DomainViolation({
            kind: 'invalid-role',
            permitted: parsed.permitted,
          });
        }
        const role: Role = parsed.role;

        // The repository is tenant-scoped, so a membership from elsewhere is
        // simply not found — which is also the response requirement 9.2 asks
        // for, without the use case having to decide anything.
        const membership = await repositories.memberships.findById(
          command.membershipId,
        );
        if (membership === null) {
          throw new DomainViolation({ kind: 'not-found' });
        }

        assertTenantRetainsAdministrator({
          activeAdministratorCount:
            await repositories.memberships.countActiveAdministrators(),
          changeRemovesAnAdministrator:
            membership.status === 'active' &&
            membership.role === 'admin' &&
            role !== 'admin',
        });

        await repositories.memberships.updateRole(membership.id, role);
      },
    );
  }
}
