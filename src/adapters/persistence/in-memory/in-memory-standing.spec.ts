import type { StandingContractWorld } from '../../testing/standing-repository.contract';
import { describesCallerStanding } from '../../testing/standing-repository.contract';
import { SequentialIdentifierGenerator } from '../../testing/sequential-identifier-generator';
import { emailAddress, personId } from '../../../domain/identifiers';
import {
  createMembership,
  revokeMembership,
} from '../../../domain/membership/membership.entity';
import {
  createPerson,
  deactivatePerson,
} from '../../../domain/person/person.entity';
import {
  createTenant,
  deactivateTenant,
} from '../../../domain/tenant/tenant.entity';
import { InMemoryApiKeyStore } from './in-memory-api-key-store';
import { InMemoryAuthenticatorUnitOfWork } from './in-memory-authenticator-unit-of-work';
import { InMemoryCredentialStore } from './in-memory-credential-store';
import { InMemoryIdentityStore } from './in-memory-identity-store';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * The double, held to the same contract as the real adapter.
 *
 * Rows are written straight into the store rather than through the units of
 * work, because the contract's fixtures include states the platform reaches by
 * transitions this suite has no reason to replay — a revoked membership, a
 * retired tenant. The shapes are still built by the domain's own constructors,
 * so an invalid one cannot be arranged.
 */
describe('the in-memory standing repository', () => {
  let world: StandingContractWorld;

  beforeEach(() => {
    const store = new InMemoryIdentityStore();
    const credentials = new InMemoryCredentialStore({
      byEmail: (email) => store.findPersonByEmail(email) ?? null,
      byId: (id) => store.people.get(id) ?? null,
    });
    const identifiers = new SequentialIdentifierGenerator();
    const unitOfWork = new InMemoryAuthenticatorUnitOfWork(
      credentials,
      new InMemoryApiKeyStore(),
      store,
    );

    world = {
      seedPerson: (input) => {
        const person = createPerson({
          id: identifiers.personId(),
          email: emailAddress(input.email),
          createdAt: CREATED_AT,
        });
        store.people.set(
          person.id,
          input.deactivated ? deactivatePerson(person) : person,
        );
        return Promise.resolve(person.id);
      },
      seedTenant: (input) => {
        const tenant = createTenant({
          id: identifiers.tenantId(),
          name: input.name,
          createdAt: CREATED_AT,
        });
        store.insertTenant(input.inactive ? deactivateTenant(tenant) : tenant);
        return Promise.resolve(tenant.id);
      },
      seedMembership: (input) => {
        const membership = createMembership({
          id: identifiers.membershipId(),
          tenantId: input.tenantId,
          personId: input.personId,
          role: input.role,
          createdAt: CREATED_AT,
        });
        store.insertMembership(
          input.revoked ? revokeMembership(membership) : membership,
        );
        return Promise.resolve();
      },
      recordOperator: (person) => {
        credentials.operators.add(person);
        return Promise.resolve();
      },
      anUnknownPerson: () => personId('person-nobody'),
      describeCaller: (person) =>
        unitOfWork.runAsPerson(person, ({ standing }) =>
          standing.describeCaller(),
        ),
    };
  });

  describesCallerStanding(() => world);
});
