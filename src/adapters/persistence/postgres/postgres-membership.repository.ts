import { and, eq, sql } from 'drizzle-orm';
import type {
  MembershipRepository,
  MembershipWithPerson,
} from '../../../application/ports/membership.repository';
import type {
  MembershipId,
  PersonId,
  TenantId,
} from '../../../domain/identifiers';
import type {
  Membership,
  MembershipStatus,
} from '../../../domain/membership/membership.entity';
import type { Role } from '../../../domain/membership/role';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';
import { translateConstraintViolation } from './postgres-errors';
import { toMembership, toPerson } from './row-mapping';
import { memberships, people } from './schema';

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  /**
   * Every query below carries `tenant_id = <current tenant>` explicitly. The
   * row-level security policy applies the same restriction independently, and
   * that duplication is the design: two layers that cannot fail together.
   */
  private get scope() {
    return eq(memberships.tenantId, this.tenantId);
  }

  async findById(membershipId: MembershipId): Promise<Membership | null> {
    const rows = await this.tx
      .select()
      .from(memberships)
      .where(and(this.scope, eq(memberships.id, membershipId)))
      .limit(1);

    return rows.length === 0 ? null : toMembership(rows[0]);
  }

  async findByPerson(personId: PersonId): Promise<Membership | null> {
    const rows = await this.tx
      .select()
      .from(memberships)
      .where(and(this.scope, eq(memberships.personId, personId)))
      .limit(1);

    return rows.length === 0 ? null : toMembership(rows[0]);
  }

  async countActiveAdministrators(): Promise<number> {
    const rows = await this.tx
      .select({ count: sql<string>`count(*)` })
      .from(memberships)
      .where(
        and(
          this.scope,
          eq(memberships.role, 'admin'),
          eq(memberships.status, 'active'),
        ),
      );

    return Number(rows[0].count);
  }

  async listMembers(options: {
    readonly includeInactive: boolean;
  }): Promise<MembershipWithPerson[]> {
    const rows = await this.tx
      .select({ membership: memberships, person: people })
      .from(memberships)
      .innerJoin(people, eq(people.id, memberships.personId))
      .where(
        options.includeInactive
          ? this.scope
          : and(this.scope, eq(memberships.status, 'active')),
      )
      .orderBy(memberships.createdAt);

    return rows.map((row) => {
      const person = toPerson(row.person);
      return {
        membership: toMembership(row.membership),
        email: person.email,
        personStatus: person.status,
      };
    });
  }

  async insert(membership: Membership): Promise<void> {
    try {
      await this.tx.insert(memberships).values({
        id: membership.id,
        tenantId: membership.tenantId,
        personId: membership.personId,
        role: membership.role,
        status: membership.status,
        createdAt: membership.createdAt,
      });
    } catch (error) {
      translateConstraintViolation(error, {
        memberships_tenant_person_unique: { kind: 'already-a-member' },
      });
    }
  }

  async updateStatus(
    membershipId: MembershipId,
    status: MembershipStatus,
  ): Promise<void> {
    await this.tx
      .update(memberships)
      .set({ status })
      .where(and(this.scope, eq(memberships.id, membershipId)));
  }

  async updateRole(membershipId: MembershipId, role: Role): Promise<void> {
    await this.tx
      .update(memberships)
      .set({ role })
      .where(and(this.scope, eq(memberships.id, membershipId)));
  }
}
