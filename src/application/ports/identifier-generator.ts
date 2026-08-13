import type {
  ApiKeyId,
  MembershipId,
  PersonId,
  SignInId,
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
  apiKeyId(): ApiKeyId;
  signInId(): SignInId;

  /**
   * For rows nothing refers to by type — a setup token, a refresh token. They
   * need an identity in the database and nowhere else, so branding them would
   * add a type for no reader to benefit from.
   */
  rowId(): string;
}
