import type { Role } from './membership/role';

/**
 * Every failure the domain and its use cases can produce, as one closed union.
 * The inbound edge is the only place that decides how these become responses.
 *
 * `forbidden` and `not-found` stay separate here even though both must surface
 * identically to a caller. The distinction is what lets logs and tests tell a
 * denial from a genuinely absent record; collapsing it at this level would
 * throw away the diagnosis and leave nothing to assert against.
 */
export type DomainError =
  | {
      readonly kind: 'validation';
      readonly field: string;
      readonly detail: string;
    }
  | { readonly kind: 'tenant-name-taken' }
  | { readonly kind: 'already-a-member' }
  | { readonly kind: 'invalid-role'; readonly permitted: readonly Role[] }
  | { readonly kind: 'last-administrator' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' };

export class DomainViolation extends Error {
  constructor(readonly error: DomainError) {
    super(describeDomainError(error));
    this.name = 'DomainViolation';
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled domain error: ${JSON.stringify(value)}`);
}

/**
 * Exhaustive by construction: adding a member to the union without handling it
 * here fails the build at the `unreachable` call.
 */
export function describeDomainError(error: DomainError): string {
  switch (error.kind) {
    case 'validation':
      return `${error.field} ${error.detail}`;
    case 'tenant-name-taken':
      return 'a tenant with this name already exists';
    case 'already-a-member':
      return 'this person is already a member of this tenant';
    case 'invalid-role':
      return `role must be one of: ${error.permitted.join(', ')}`;
    case 'last-administrator':
      return 'a tenant must retain at least one active administrator';
    case 'not-found':
      return 'the requested record does not exist';
    case 'forbidden':
      return 'the actor is not permitted to perform this action';
    default:
      return unreachable(error);
  }
}
