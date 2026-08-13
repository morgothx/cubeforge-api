import { and, eq, sql } from 'drizzle-orm';
import type { PersonRepository } from '../../../application/ports/person.repository';
import type {
  EmailAddress,
  PersonId,
  TenantId,
} from '../../../domain/identifiers';
import type { Person } from '../../../domain/person/person.entity';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';
import { toPerson } from './row-mapping';
import { memberships, people } from './schema';

export class PostgresPersonRepository implements PersonRepository {
  constructor(
    private readonly tx: Transaction,
    private readonly tenantId: TenantId,
  ) {}

  /**
   * Joined through this tenant's memberships, which is both the tenant
   * predicate this layer owes and the same condition the `people_app_read`
   * policy applies independently.
   */
  async findById(personId: PersonId): Promise<Person | null> {
    const rows = await this.tx
      .select({
        id: people.id,
        email: people.email,
        status: people.status,
        createdAt: people.createdAt,
      })
      .from(people)
      .innerJoin(memberships, eq(memberships.personId, people.id))
      .where(
        and(eq(people.id, personId), eq(memberships.tenantId, this.tenantId)),
      )
      .limit(1);

    return rows.length === 0 ? null : toPerson(rows[0]);
  }

  /**
   * Delegates to a SECURITY DEFINER function, because this is the one question
   * that must be answered across the whole platform while the caller keeps no
   * read access to it.
   *
   * The application identity cannot see a person who belongs only to another
   * tenant, yet `people.email` is unique platform-wide. Inserting directly would
   * fail with a duplicate key, which both prevents requirement 4.2 and discloses
   * that the address is registered somewhere — requirement 4.3. The function
   * returns an identifier and nothing else.
   */
  async findOrCreateByEmail(input: {
    readonly candidateId: PersonId;
    readonly email: EmailAddress;
    readonly createdAt: Date;
  }): Promise<PersonId> {
    const result = await this.tx.execute<{ find_or_create_person: string }>(
      sql`select find_or_create_person(${input.candidateId}::uuid, ${input.email}::citext, ${input.createdAt.toISOString()}::timestamptz)`,
    );

    const [row] = result.rows;
    if (!row) {
      throw new Error('find_or_create_person returned no row');
    }
    return row.find_or_create_person as PersonId;
  }
}
