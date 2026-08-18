import { and, eq, sql } from 'drizzle-orm';
import type {
  CallerStandingRecord,
  StandingRepository,
} from '../../../application/ports/standing.repository';
import { toMembership, toPerson, toTenant } from './row-mapping';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';
import { memberships, people, platformOperators, tenants } from './schema';

/**
 * The one read in the platform that spans tenants.
 *
 * It names no person anywhere. `current_person_id()` reads what the unit of
 * work published, the policy on `memberships` admits only that person's rows,
 * and the person themself is read by the same function — so a predicate this
 * query could get wrong does not exist. That is the point of the shape: the
 * confinement is in the database, not in the SQL, and the next edit to this
 * file cannot loosen it.
 */
export class PostgresStandingRepository implements StandingRepository {
  constructor(private readonly tx: Transaction) {}

  async describeCaller(): Promise<CallerStandingRecord | null> {
    const person = await this.readPerson();
    if (person === null) {
      return null;
    }

    const [operator, held] = await Promise.all([
      this.readOperator(),
      this.readMemberships(),
    ]);

    return { person, isOperator: operator, memberships: held };
  }

  private async readPerson() {
    const rows = await this.tx
      .select()
      .from(people)
      .where(eq(people.id, sql`current_person_id()`))
      .limit(1);

    return rows.length === 0 ? null : toPerson(rows[0]);
  }

  /**
   * "Recorded, and still an active person" — the meaning
   * `OperatorStatusRepository.isOperator` already carries. Two answers to the
   * same word would be worse than either.
   */
  private async readOperator(): Promise<boolean> {
    const rows = await this.tx
      .select({ present: sql<number>`1` })
      .from(platformOperators)
      .innerJoin(people, eq(people.id, platformOperators.personId))
      .where(
        and(
          eq(platformOperators.personId, sql`current_person_id()`),
          eq(people.status, 'active'),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  /**
   * An inner join on `tenants`, which the authenticating identity may read in
   * full: an inactive tenant's row comes back like any other, so a membership
   * of one is reported rather than silently dropped. Deciding what a
   * membership currently grants is `decideAccess`'s job, and a join that
   * quietly answered part of that question would hide it.
   */
  private async readMemberships() {
    const rows = await this.tx
      .select({ membership: memberships, tenant: tenants })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId));

    return rows.map((row) => ({
      tenant: toTenant(row.tenant),
      membership: toMembership(row.membership),
    }));
  }
}
