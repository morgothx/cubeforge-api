import {
  emailAddress,
  membershipId,
  personId,
  tenantId,
} from '../../../domain/identifiers';
import type {
  Membership,
  MembershipStatus,
} from '../../../domain/membership/membership.entity';
import { parseRole, type Role } from '../../../domain/membership/role';
import type {
  Person,
  PersonStatus,
} from '../../../domain/person/person.entity';
import type {
  Tenant,
  TenantStatus,
} from '../../../domain/tenant/tenant.entity';

interface TenantRow {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
}

interface PersonRow {
  id: string;
  email: string;
  status: string;
  createdAt: Date;
}

interface MembershipRow {
  id: string;
  tenantId: string;
  personId: string;
  role: string;
  status: string;
  createdAt: Date;
}

/**
 * Status columns are constrained text rather than an enum type, so the driver
 * hands them back as plain strings. Narrowing them here rather than casting
 * means a value the check constraint somehow admitted — a migration that
 * widened it without updating the domain, say — fails loudly at the boundary
 * instead of travelling into the domain disguised as a valid state.
 */
function narrow<T extends string>(
  value: string,
  permitted: readonly T[],
  column: string,
): T {
  if ((permitted as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `${column} holds "${value}", which is not one of: ${permitted.join(', ')}`,
  );
}

const TENANT_STATUSES: readonly TenantStatus[] = ['active', 'inactive'];
const PERSON_STATUSES: readonly PersonStatus[] = ['active', 'deactivated'];
const MEMBERSHIP_STATUSES: readonly MembershipStatus[] = ['active', 'revoked'];

export function toTenant(row: TenantRow): Tenant {
  return {
    id: tenantId(row.id),
    name: row.name,
    status: narrow(row.status, TENANT_STATUSES, 'tenants.status'),
    createdAt: row.createdAt,
  };
}

export function toPerson(row: PersonRow): Person {
  return {
    id: personId(row.id),
    email: emailAddress(row.email),
    status: narrow(row.status, PERSON_STATUSES, 'people.status'),
    createdAt: row.createdAt,
  };
}

export function toMembership(row: MembershipRow): Membership {
  return {
    id: membershipId(row.id),
    tenantId: tenantId(row.tenantId),
    personId: personId(row.personId),
    role: toRole(row.role),
    status: narrow(row.status, MEMBERSHIP_STATUSES, 'memberships.status'),
    createdAt: row.createdAt,
  };
}

function toRole(value: string): Role {
  const parsed = parseRole(value);
  if (!parsed.ok) {
    throw new Error(
      `memberships.role holds "${value}", which is not one of: ${parsed.permitted.join(', ')}`,
    );
  }
  return parsed.role;
}
