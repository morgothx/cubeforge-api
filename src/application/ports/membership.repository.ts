import type {
  EmailAddress,
  MembershipId,
  PersonId,
} from '../../domain/identifiers';
import type {
  Membership,
  MembershipStatus,
} from '../../domain/membership/membership.entity';
import type { Role } from '../../domain/membership/role';
import type { PersonStatus } from '../../domain/person/person.entity';

/**
 * A membership together with the person it belongs to, which is what a member
 * listing needs. The email is included because requirement 10.3 permits it
 * precisely here: to an administrator of a tenant the person belongs to.
 */
export interface MembershipWithPerson {
  readonly membership: Membership;
  readonly email: EmailAddress;
  readonly personStatus: PersonStatus;
}

/**
 * Memberships of the tenant in context. No method takes a tenant: the scope
 * comes from the transaction, so passing the wrong one is not a mistake anyone
 * can make here.
 */
export interface MembershipRepository {
  findById(membershipId: MembershipId): Promise<Membership | null>;
  findByPerson(personId: PersonId): Promise<Membership | null>;

  /** Feeds the last-administrator invariant, which is arithmetic over this. */
  countActiveAdministrators(): Promise<number>;

  listMembers(options: {
    readonly includeInactive: boolean;
  }): Promise<MembershipWithPerson[]>;

  /**
   * Throws `DomainViolation({ kind: 'already-a-member' })` when the person
   * already holds a membership in this tenant, for the same reason tenant names
   * are checked in the store: a read followed by an insert is a race.
   */
  insert(membership: Membership): Promise<void>;
  updateStatus(
    membershipId: MembershipId,
    status: MembershipStatus,
  ): Promise<void>;
  updateRole(membershipId: MembershipId, role: Role): Promise<void>;
}
