/**
 * The permitted roles, declared once. Both the domain and the inbound edge
 * report this same list when rejecting an unknown value, so the two can never
 * disagree about what is allowed.
 */
export const PERMITTED_ROLES = ['admin', 'editor', 'viewer'] as const;

export type Role = (typeof PERMITTED_ROLES)[number];

export type RoleParseResult =
  | { readonly ok: true; readonly role: Role }
  | { readonly ok: false; readonly permitted: readonly Role[] };

function isRole(value: string): value is Role {
  return (PERMITTED_ROLES as readonly string[]).includes(value);
}

/**
 * Returns a result rather than throwing: an unknown role is ordinary invalid
 * input from a caller, not an exceptional condition, and the caller needs the
 * permitted set to build its response.
 */
export function parseRole(value: string): RoleParseResult {
  if (isRole(value)) {
    return { ok: true, role: value };
  }
  return { ok: false, permitted: PERMITTED_ROLES };
}
