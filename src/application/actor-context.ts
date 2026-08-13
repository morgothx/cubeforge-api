import type { PersonId, TenantId } from '../domain/identifiers';

/**
 * Who is making the request, as the use cases receive it.
 *
 * The two kinds are a union rather than one shape with optional fields so that
 * "an operator acting inside a tenant" cannot be expressed at all. Requirement
 * 3.2 forbids it, and a shape that cannot represent it needs no check to
 * enforce it.
 *
 * Operators carry no identity here: nothing in this feature attributes an action
 * to a particular operator, and there is no credential to resolve one from until
 * authentication arrives in feature 2.
 */
export type ActorContext =
  | { readonly kind: 'platform-operator' }
  | {
      readonly kind: 'tenant-member';
      readonly personId: PersonId;
      readonly tenantId: TenantId;
    };
