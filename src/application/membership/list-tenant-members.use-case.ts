import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../actor-context';
import type { MembershipWithPerson } from '../ports/membership.repository';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { authorizeInTenant, tenantOf } from '../tenant-authorization';

export interface ListTenantMembersQuery {
  readonly actor: ActorContext;
  readonly includeInactive: boolean;
}

/**
 * Administrators only, because the listing carries email addresses and
 * requirement 10.3 permits those exactly to administrators of a tenant the
 * person belongs to.
 */
@Injectable()
export class ListTenantMembersUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
  ) {}

  async execute(
    query: ListTenantMembersQuery,
  ): Promise<MembershipWithPerson[]> {
    return this.unitOfWork.runInTenant(
      tenantOf(query.actor),
      async (repositories) => {
        await authorizeInTenant(repositories, query.actor, ['admin']);
        return repositories.memberships.listMembers({
          includeInactive: query.includeInactive,
        });
      },
    );
  }
}
