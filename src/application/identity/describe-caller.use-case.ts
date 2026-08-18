import { Inject, Injectable } from '@nestjs/common';
import { decideAccess } from '../../domain/access/access-decision';
import { DomainViolation } from '../../domain/errors';
import type {
  EmailAddress,
  PersonId,
  TenantId,
} from '../../domain/identifiers';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import {
  AUTHENTICATOR_UNIT_OF_WORK,
  type AuthenticatorUnitOfWork,
} from '../ports/authenticator-unit-of-work';
import type { CallerStandingRecord } from '../ports/standing.repository';

export interface DescribeCallerQuery {
  readonly actor: ActorContext;
}

export interface StandingMembership {
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly role: Role;
}

export interface CallerStanding {
  readonly personId: PersonId;
  readonly email: EmailAddress;
  readonly isOperator: boolean;
  readonly memberships: readonly StandingMembership[];
}

/**
 * Who the caller is, and where they may currently act.
 *
 * The query takes an actor rather than a person identifier, and there is no
 * overload that takes one. That is requirement 2.3 made structural: a caller
 * can only be described by having authenticated as them, which is settled
 * before this use case runs and cannot be re-decided inside it.
 *
 * Read on every request, never carried in a credential. A client that re-asks
 * after a role changes sees the change — the reason this is a query rather
 * than a token claim.
 */
@Injectable()
export class DescribeCallerUseCase {
  constructor(
    @Inject(AUTHENTICATOR_UNIT_OF_WORK)
    private readonly authenticator: AuthenticatorUnitOfWork,
  ) {}

  async execute(query: DescribeCallerQuery): Promise<CallerStanding> {
    const caller = callerPersonOf(query.actor);

    const record = await this.authenticator.runAsPerson(
      caller,
      ({ standing }) => standing.describeCaller(),
    );
    if (record === null) {
      // The resolver read this person moments ago, so an absence here means
      // they were removed in between. An ordinary absence, like every other.
      throw new DomainViolation(
        { kind: 'not-found' },
        'the caller resolved to a person the platform no longer holds',
      );
    }

    return present(record);
  }
}

/**
 * The two kinds that name a person acting outside any tenant, which is exactly
 * the set the `{ person: true }` declaration admits.
 *
 * A tenant member is refused because their request named a tenant and is
 * therefore a different question; a machine because an API key names a
 * credential, not a person, and has no standing to describe. Both are already
 * refused by the guard — this is here so the answer does not depend on which
 * declaration some future route happens to carry.
 */
function callerPersonOf(actor: ActorContext): PersonId {
  if (actor.kind === 'person' || actor.kind === 'platform-operator') {
    return actor.personId;
  }
  throw new DomainViolation(
    { kind: 'forbidden' },
    'a caller standing was asked for by an actor that names no person acting alone',
  );
}

/**
 * Drops every membership that does not currently grant access, by asking the
 * domain's own rule rather than by re-reading the statuses here.
 *
 * `decideAccess` is what the guard and the tenant-scoped use cases ask, so a
 * tenant this answer names is a tenant the caller can actually reach — and the
 * granted role comes from the decision, which means the two can never report
 * different roles for the same membership.
 */
function present(record: CallerStandingRecord): CallerStanding {
  const memberships = record.memberships
    .flatMap(({ tenant, membership }) => {
      const decision = decideAccess({
        tenant,
        person: record.person,
        membership,
      });
      return decision.granted
        ? [
            {
              tenantId: tenant.id,
              tenantName: tenant.name,
              role: decision.role,
            },
          ]
        : [];
    })
    // A stable order, so a client can render the list without sorting it and
    // two calls that changed nothing look like they changed nothing.
    .sort((a, b) => a.tenantName.localeCompare(b.tenantName));

  return {
    personId: record.person.id,
    email: record.person.email,
    isOperator: record.isOperator,
    memberships,
  };
}
