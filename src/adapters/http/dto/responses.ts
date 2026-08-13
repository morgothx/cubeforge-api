import type { CreateTenantMemberResult } from '../../../application/membership/create-tenant-member.use-case';
import type { MembershipWithPerson } from '../../../application/ports/membership.repository';
import type { Tenant } from '../../../domain/tenant/tenant.entity';

export interface TenantResponse {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
}

/**
 * Built field by field rather than by spreading the entity. A response that
 * spreads whatever the domain happens to carry will one day leak a field nobody
 * decided to publish; listing them is how the contract stays a decision.
 */
export function toTenantResponse(tenant: Tenant): TenantResponse {
  return {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
  };
}

export interface MemberResponse {
  readonly membershipId: string;
  readonly personId: string;
  readonly email: string;
  readonly role: string;
  readonly active: boolean;
}

export function toMemberResponse(entry: MembershipWithPerson): MemberResponse {
  return {
    membershipId: entry.membership.id,
    personId: entry.membership.personId,
    email: entry.email,
    role: entry.membership.role,
    // Requirement 10.1 asks whether the membership is active, not what its
    // status string happens to be — a person deactivated platform-wide is not
    // active here either.
    active:
      entry.membership.status === 'active' && entry.personStatus === 'active',
  };
}

export interface CreatedMemberResponse {
  readonly membershipId: string;
  readonly personId: string;
  readonly role: string;
}

/**
 * Deliberately identical in both branches of requirement 4.2: there is no field
 * that could differ between a person the platform already knew and one it did
 * not, because no such field is produced.
 */
export function toCreatedMemberResponse(
  result: CreateTenantMemberResult,
): CreatedMemberResponse {
  return {
    membershipId: result.membershipId,
    personId: result.personId,
    role: result.role,
  };
}
