declare const brand: unique symbol;

/**
 * Nominal typing over a primitive. Two branded aliases of the same underlying
 * type are mutually incompatible, so a person identifier cannot reach a
 * parameter expecting a tenant identifier.
 */
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Branded<string, 'TenantId'>;
export type PersonId = Branded<string, 'PersonId'>;
export type MembershipId = Branded<string, 'MembershipId'>;
export type EmailAddress = Branded<string, 'EmailAddress'>;
/** Groups every refresh token descended from one sign-in, so the family can end together. */
export type SignInId = Branded<string, 'SignInId'>;
export type ApiKeyId = Branded<string, 'ApiKeyId'>;

function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be blank`);
  }
  return trimmed;
}

export function tenantId(value: string): TenantId {
  return requireNonBlank(value, 'tenant identifier') as TenantId;
}

/** What the `uuid` column holding a tenant identifier will accept. */
const WELL_FORMED = /^[0-9a-fA-F-]{36}$/;

/**
 * Refuses a tenant identifier that is not the shape the database stores.
 *
 * Called wherever a tenant identifier stops being a value and becomes **part of
 * something that is parsed** — a path, a statement. There it is the one way a
 * tenant could reach somewhere that is not its own with every query being
 * correct, so the shape is checked rather than trusted.
 *
 * Deliberately not folded into `tenantId` itself: that one parses an identifier
 * arriving from outside, where a malformed value must become a refusal the
 * caller cannot distinguish from a tenant that does not exist. Turning it into
 * a throw there would answer a question the disclosure rules say must not be
 * answered.
 *
 * `use` names what it was about to become, so the refusal says which of the two
 * callers refused and why.
 */
export function requireWellFormedTenant(value: string, use: string): string {
  if (!WELL_FORMED.test(value)) {
    throw new Error(`a tenant identifier is not ${use}: "${value}"`);
  }
  return value;
}

export function personId(value: string): PersonId {
  return requireNonBlank(value, 'person identifier') as PersonId;
}

export function membershipId(value: string): MembershipId {
  return requireNonBlank(value, 'membership identifier') as MembershipId;
}

export function signInId(value: string): SignInId {
  return requireNonBlank(value, 'sign-in identifier') as SignInId;
}

export function apiKeyId(value: string): ApiKeyId {
  return requireNonBlank(value, 'API key identifier') as ApiKeyId;
}

/**
 * Addresses are compared platform-wide to decide whether a person already
 * exists, so normalization has to happen once, here, rather than at each call
 * site. Anything looser would let the same person be created twice under
 * different casing and quietly break the multi-tenant membership model.
 */
export function emailAddress(value: string): EmailAddress {
  const normalized = requireNonBlank(value, 'email address').toLowerCase();

  const separator = normalized.indexOf('@');
  const hasLocalPart = separator > 0;
  const hasDomainPart = separator < normalized.length - 1;
  if (!hasLocalPart || !hasDomainPart) {
    throw new Error('email address must contain a local and a domain part');
  }

  return normalized as EmailAddress;
}
