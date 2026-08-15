import { Inject, Injectable } from '@nestjs/common';
import type {
  EmailAddress,
  MembershipId,
  PersonId,
} from '../../domain/identifiers';
import type { Role } from '../../domain/membership/role';
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

export interface ListedMember {
  readonly membershipId: MembershipId;
  readonly personId: PersonId;
  /** Withheld from everyone but an administrator of this tenant (2.1.1). */
  readonly email: EmailAddress | null;
  readonly role: Role;
  readonly active: boolean;
}

/** Every member of the tenant may see who is here. */
export const LIST_TENANT_MEMBERS_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly Role[];

/**
 * Any member may read the listing; only an administrator reads the addresses in
 * it.
 *
 * Requirement 10.3 of the identity feature reserves a person's email address to
 * administrators of a tenant they belong to. Opening this route to editors and
 * viewers would have weakened that rule by a side effect, so the addresses are
 * withheld instead and the rule survives intact.
 *
 * The decision lives here rather than in the response mapper: what a caller may
 * learn is a rule about access, and this is the layer that just resolved their
 * role in order to answer at all.
 */
@Injectable()
export class ListTenantMembersUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
  ) {}

  async execute(query: ListTenantMembersQuery): Promise<ListedMember[]> {
    return this.unitOfWork.runInTenant(
      tenantOf(query.actor),
      async (repositories) => {
        const { role } = await authorizeInTenant(
          repositories,
          query.actor,
          LIST_TENANT_MEMBERS_ROLES,
        );
        const members = await repositories.memberships.listMembers({
          includeInactive: query.includeInactive,
        });

        return members.map((member) => present(member, role === 'admin'));
      },
    );
  }
}

function present(
  entry: MembershipWithPerson,
  disclosesAddresses: boolean,
): ListedMember {
  return {
    membershipId: entry.membership.id,
    personId: entry.membership.personId,
    email: disclosesAddresses ? entry.email : null,
    role: entry.membership.role,
    // Requirement 10.1 asks whether the membership is active, not what its
    // status string happens to be — a person deactivated platform-wide is not
    // active here either.
    active:
      entry.membership.status === 'active' && entry.personStatus === 'active',
  };
}
