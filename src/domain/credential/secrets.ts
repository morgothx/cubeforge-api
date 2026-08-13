declare const brand: unique symbol;

/**
 * Nominal typing for the three kinds of secret material this feature handles.
 *
 * A separate brand from `identifiers.ts` on purpose: the point here is not to
 * keep one identifier out of another's parameter, it is to make handing a raw
 * secret to something expecting a digest a compile error. That mistake writes a
 * password into a column in plain text, and it is exactly the kind that reviews
 * miss.
 */
type Secret<B extends string> = string & { readonly [brand]: B };

/** A password put through a slow, salted hash. Safe to store. */
export type PasswordDigest = Secret<'PasswordDigest'>;

/** A high-entropy value handed to a caller once. Never stored. */
export type OpaqueSecret = Secret<'OpaqueSecret'>;

/** The stored form of an opaque secret. Safe to store, useless to a thief. */
export type SecretDigest = Secret<'SecretDigest'>;

/** A signed statement that a person authenticated. Never stored. */
export type AccessToken = Secret<'AccessToken'>;

export function passwordDigest(value: string): PasswordDigest {
  return requireNonBlank(value, 'password digest') as PasswordDigest;
}

export function opaqueSecret(value: string): OpaqueSecret {
  return requireNonBlank(value, 'secret') as OpaqueSecret;
}

export function secretDigest(value: string): SecretDigest {
  return requireNonBlank(value, 'secret digest') as SecretDigest;
}

export function accessToken(value: string): AccessToken {
  return requireNonBlank(value, 'access token') as AccessToken;
}

function requireNonBlank(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
  return value;
}
