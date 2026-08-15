import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import {
  emailAddress,
  type MembershipId,
  type PersonId,
} from '../../domain/identifiers';
import { createMembership } from '../../domain/membership/membership.entity';
import { parseRole, type Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import { CLOCK, type Clock } from '../ports/clock';
import {
  IDENTIFIER_GENERATOR,
  type IdentifierGenerator,
} from '../ports/identifier-generator';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { authorizeInTenant, tenantOf } from '../tenant-authorization';

export interface CreateTenantMemberCommand {
  readonly actor: ActorContext;
  readonly email: string;
  readonly role: string;
}

export interface CreateTenantMemberResult {
  readonly membershipId: MembershipId;
  readonly personId: PersonId;
  readonly role: Role;
}

/** Adding someone to a tenant is an administrative act. */
export const CREATE_TENANT_MEMBER_ROLES = [
  'admin',
] as const satisfies readonly Role[];

/**
 * The use case that carries requirement 4.3, so its shape is deliberate.
 *
 * There is no branch on whether the person already existed. Resolving the
 * address and creating the person are one operation, and everything after it is
 * the same work in the same order either way. A caller cannot tell the two cases
 * apart from the response, and there is no extra round trip on one path to tell
 * them apart from the timing.
 */
@Injectable()
export class CreateTenantMemberUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTIFIER_GENERATOR)
    private readonly identifiers: IdentifierGenerator,
  ) {}

  async execute(
    command: CreateTenantMemberCommand,
  ): Promise<CreateTenantMemberResult> {
    return this.unitOfWork.runInTenant(
      tenantOf(command.actor),
      async (repositories) => {
        await authorizeInTenant(
          repositories,
          command.actor,
          CREATE_TENANT_MEMBER_ROLES,
        );

        const role = this.parseRole(command.role);
        const email = this.parseEmail(command.email);
        const createdAt = this.clock.now();

        const personId = await repositories.people.findOrCreateByEmail({
          candidateId: this.identifiers.personId(),
          email,
          createdAt,
        });

        const membership = createMembership({
          id: this.identifiers.membershipId(),
          tenantId: tenantOf(command.actor),
          personId,
          role,
          createdAt,
        });

        // Rejects with `already-a-member` when this person is already in this
        // tenant (4.4). That is the only rejection possible here, and it
        // discloses nothing about any other tenant.
        await repositories.memberships.insert(membership);

        return {
          membershipId: membership.id,
          personId,
          role: membership.role,
        };
      },
    );
  }

  private parseRole(value: string): Role {
    const parsed = parseRole(value);
    if (!parsed.ok) {
      throw new DomainViolation({
        kind: 'invalid-role',
        permitted: parsed.permitted,
      });
    }
    return parsed.role;
  }

  /**
   * The domain rejects a malformed address by throwing, which is right for a
   * value object but says nothing about which field a caller got wrong. This
   * turns it into the error the edge can act on.
   */
  private parseEmail(value: string) {
    try {
      return emailAddress(value);
    } catch (error) {
      throw new DomainViolation({
        kind: 'validation',
        field: 'email',
        detail: error instanceof Error ? error.message : 'is invalid',
      });
    }
  }
}
