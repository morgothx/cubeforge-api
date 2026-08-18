import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresAuthenticatorUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-authenticator-unit-of-work';
import type { StandingContractWorld } from '../../src/adapters/testing/standing-repository.contract';
import { describesCallerStanding } from '../../src/adapters/testing/standing-repository.contract';
import {
  personId as toPersonId,
  tenantId as toTenantId,
} from '../../src/domain/identifiers';
import { runtimePool, seed } from './support/database';
import { seedOperator } from './support/fixtures';
import { useIntegrationDatabase } from './support/fixtures';

/**
 * The real standing repository, held to the same contract as the double.
 *
 * The double passing this suite is what earns every use-case test that trusts
 * it; this one passing is what says the double was telling the truth. Neither
 * is worth much alone, which is why the assertions live in one place and only
 * the seeding differs.
 *
 * Fixtures are written as the superuser because forced row-level security
 * leaves no runtime identity able to insert a membership — the authenticating
 * one holds `SELECT` and nothing else, which is itself asserted elsewhere.
 */
describe('the standing repository against PostgreSQL', () => {
  useIntegrationDatabase();

  let world: StandingContractWorld;

  beforeEach(() => {
    const unitOfWork = new PostgresAuthenticatorUnitOfWork(
      drizzle(runtimePool('authenticator')),
    );

    world = {
      seedPerson: async (input) => {
        const id = randomUUID();
        await seed((client) =>
          client.query(
            'INSERT INTO people (id, email, status) VALUES ($1, $2, $3)',
            [id, input.email, input.deactivated ? 'deactivated' : 'active'],
          ),
        );
        return toPersonId(id);
      },
      seedTenant: async (input) => {
        const id = randomUUID();
        await seed((client) =>
          client.query(
            'INSERT INTO tenants (id, name, status) VALUES ($1, $2, $3)',
            [id, input.name, input.inactive ? 'inactive' : 'active'],
          ),
        );
        return toTenantId(id);
      },
      seedMembership: async (input) => {
        await seed((client) =>
          client.query(
            `INSERT INTO memberships (id, tenant_id, person_id, role, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              randomUUID(),
              input.tenantId,
              input.personId,
              input.role,
              input.revoked ? 'revoked' : 'active',
            ],
          ),
        );
      },
      recordOperator: (person) => seedOperator(person),
      anUnknownPerson: () => toPersonId(randomUUID()),
      describeCaller: (person) =>
        unitOfWork.runAsPerson(person, ({ standing }) =>
          standing.describeCaller(),
        ),
    };
  });

  describesCallerStanding(() => world);
});
