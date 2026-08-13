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
