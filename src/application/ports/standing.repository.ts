import type { Membership } from '../../domain/membership/membership.entity';
import type { Person } from '../../domain/person/person.entity';
import type { Tenant } from '../../domain/tenant/tenant.entity';

/**
 * One membership of the caller, with the tenant it points at.
 *
 * The tenant travels whole rather than as an identifier and a name, because the
 * rule that decides whether this membership currently grants anything needs the
 * tenant's status as much as the membership's own.
 */
export interface StandingMembershipRecord {
  readonly tenant: Tenant;
  readonly membership: Membership;
}

/**
 * Everything the platform knows about one caller, unfiltered.
 *
 * Revoked memberships and inactive tenants are present. That is deliberate: the
 * rule for what currently grants access is `decideAccess`, which lives in the
 * domain and is the same rule the guard and the tenant use cases apply. A
 * repository that filtered here would be a second copy of it, free to drift.
 */
export interface CallerStandingRecord {
  readonly person: Person;
  readonly isOperator: boolean;
  readonly memberships: readonly StandingMembershipRecord[];
}

export interface StandingRepository {
  /**
   * Of the published person, and of nobody else.
   *
   * It takes no person on purpose. The person is whoever the transaction
   * published, so a caller cannot ask for someone else's standing — the
   * mistake requirement 2.1 forbids is not expressible rather than merely
   * prohibited. `null` means no such person, which is also what a transaction
   * with nobody published sees.
   */
  describeCaller(): Promise<CallerStandingRecord | null>;
}
