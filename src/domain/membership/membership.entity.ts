import type { MembershipId, PersonId, TenantId } from '../identifiers';
import type { Role } from './role';

export type MembershipStatus = 'active' | 'revoked';

/**
 * The link that grants a person access to one tenant, carrying the role for
 * that tenant only. Role lives here rather than on the person precisely so the
 * same individual can be an administrator of one customer and a viewer of
 * another without either fact leaking into the other.
 */
export interface Membership {
  readonly id: MembershipId;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly role: Role;
  readonly status: MembershipStatus;
  readonly createdAt: Date;
}

export function createMembership(input: {
  readonly id: MembershipId;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly role: Role;
  readonly createdAt: Date;
}): Membership {
  return { ...input, status: 'active' };
}

export function revokeMembership(membership: Membership): Membership {
  if (membership.status === 'revoked') {
    return membership;
  }
  return { ...membership, status: 'revoked' };
}

export function changeMembershipRole(
  membership: Membership,
  role: Role,
): Membership {
  return { ...membership, role };
}

export function isMembershipActive(membership: Membership): boolean {
  return membership.status === 'active';
}
