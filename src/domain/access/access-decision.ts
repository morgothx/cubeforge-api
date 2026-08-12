import type { Membership } from '../membership/membership.entity';
import { isMembershipActive } from '../membership/membership.entity';
import type { Role } from '../membership/role';
import type { Person } from '../person/person.entity';
import { isPersonActive } from '../person/person.entity';
import type { Tenant } from '../tenant/tenant.entity';
import { isTenantActive } from '../tenant/tenant.entity';

export type AccessRefusal =
  | { readonly kind: 'tenant-inactive' }
  | { readonly kind: 'person-deactivated' }
  | { readonly kind: 'no-membership' }
  | { readonly kind: 'membership-revoked' };

export type AccessDecision =
  | { readonly granted: true; readonly role: Role }
  | { readonly granted: false; readonly refusal: AccessRefusal };

/**
 * One evaluation for what would otherwise be four scattered checks. Tenant
 * inactive, person deactivated, no membership and revoked membership are the
 * same question — may this actor act in this tenant right now — reached by
 * different causes.
 *
 * The refusal reason exists for logs and tests only. Every refusal reaches a
 * caller as the same not-found response, because distinguishing them would let
 * one customer confirm the existence of another's records.
 *
 * Check order is broadest scope first: the tenant, then the person
 * platform-wide, then their link to this specific tenant. Only the reported
 * reason depends on that order, never whether access is granted.
 */
export function decideAccess(input: {
  readonly tenant: Tenant;
  readonly person: Person;
  readonly membership: Membership | null;
}): AccessDecision {
  if (!isTenantActive(input.tenant)) {
    return { granted: false, refusal: { kind: 'tenant-inactive' } };
  }

  if (!isPersonActive(input.person)) {
    return { granted: false, refusal: { kind: 'person-deactivated' } };
  }

  const { membership } = input;
  // A membership belonging to another tenant is treated as absent rather than
  // as a mismatch: the actor has no standing here, and saying anything more
  // specific would confirm the other tenant's existence.
  if (membership === null || membership.tenantId !== input.tenant.id) {
    return { granted: false, refusal: { kind: 'no-membership' } };
  }

  if (!isMembershipActive(membership)) {
    return { granted: false, refusal: { kind: 'membership-revoked' } };
  }

  return { granted: true, role: membership.role };
}
