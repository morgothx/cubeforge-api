import type { ApiKeyId, PersonId, TenantId } from '../domain/identifiers';
import type { Role } from '../domain/membership/role';

/**
 * Who is making the request, as the use cases receive it.
 *
 * The kinds are a union rather than one shape with optional fields so that
 * "an operator acting inside a tenant" cannot be expressed at all. Requirement
 * 3.2 of the identity feature forbids it, and a shape that cannot represent it
 * needs no check to enforce it.
 *
 * An operator carries a `personId` because an operator is a person: they hold a
 * credential like anyone else, and every act of theirs must be attributable to
 * a human rather than to an office. The identity feature modelled them without
 * one, which was tenable only while nothing verified who they were.
 *
 * A machine principal names its tenant and its role directly, because an API
 * key is issued into one tenant with one role and holds no membership. Nothing
 * in the identity feature accepts it — `tenantOf` refuses any actor that is not
 * a tenant member — so a machine reaching those routes is answered as an
 * absence. That is correct: those routes are for people.
 */
export type ActorContext =
  | { readonly kind: 'platform-operator'; readonly personId: PersonId }
  /**
   * A person who authenticated and is acting inside no tenant. Distinct from a
   * tenant member, which carries a tenant every check on it assumes: making
   * that tenant nullable instead would leave those checks compiling and quietly
   * wrong.
   *
   * Nothing tenant-scoped admits this kind. Every such check is written as "not
   * a tenant member", so a person is refused there — but by the shape of the
   * comparison rather than by the type system, since nothing switches on this
   * union exhaustively. The refusals are asserted in tests for exactly that
   * reason.
   */
  | { readonly kind: 'person'; readonly personId: PersonId }
  | {
      readonly kind: 'tenant-member';
      readonly personId: PersonId;
      readonly tenantId: TenantId;
    }
  | {
      readonly kind: 'machine';
      readonly apiKeyId: ApiKeyId;
      readonly tenantId: TenantId;
      readonly role: Role;
    };
