import type {
  MembershipId,
  PersonId,
  TenantId,
} from '../../domain/identifiers';

export const IDENTIFIER_GENERATOR = Symbol('IDENTIFIER_GENERATOR');

/**
 * One method per kind of identifier rather than a single `generate(): string`.
 * The identifiers are branded types, so this is what keeps a freshly generated
 * person identifier from being handed to something expecting a tenant.
 */
export interface IdentifierGenerator {
  tenantId(): TenantId;
  personId(): PersonId;
  membershipId(): MembershipId;
}
