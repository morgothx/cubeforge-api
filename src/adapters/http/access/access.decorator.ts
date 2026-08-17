import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import { PERMITTED_ROLES, type Role } from '../../../domain/membership/role';

/**
 * What a route says about who may reach it.
 *
 * A union rather than a record of optional flags, which stops the compiler
 * accepting a declaration that states nothing, one that admits machines without
 * roles, or a role outside the permitted three.
 *
 * It does not stop everything, and the comment that claimed otherwise was
 * wrong: TypeScript's excess-property check against a union permits any
 * property that appears in *some* member, so `{ public: true, roles: [...] }`
 * compiles. Those combinations, an empty role list, and anything arriving
 * through a cast are refused at construction instead — which is why the runtime
 * check covers every illegal shape rather than only the ones the type misses.
 */
export type AccessDeclaration =
  /** Reachable with no principal at all. */
  | { readonly public: true }
  /** Reachable only by a platform operator, which is not a tenant role. */
  | { readonly operator: true }
  /**
   * Reachable by any caller whose credential names a person — a person acting
   * in no tenant, or an operator. Not a machine, which names a credential
   * rather than a person, and not a tenant member, whose request named a tenant
   * and is therefore not the kind of request this shape describes.
   *
   * The widest thing a route can say short of `public`, and the only shape that
   * neither names a tenant nor demands standing in one.
   */
  | { readonly person: true }
  /**
   * Reachable by a person holding one of these roles in the tenant the request
   * names. `machines` additionally admits an API key carrying one of them; no
   * shipped route sets it, and the guard confines an admitted key to its own
   * tenant.
   */
  | { readonly roles: readonly Role[]; readonly machines?: true };

/**
 * One key, so "this route declares nothing" is one absent thing rather than a
 * combination of absences that has to be interpreted. The guard refuses on that
 * absence, which is what makes an unprotected route impossible to ship by
 * forgetting rather than by deciding.
 */
export const ACCESS_DECLARATION = Symbol('ACCESS_DECLARATION');

/**
 * Attaches a declaration to a handler, or to a controller as a default its
 * handlers may narrow.
 *
 * The validation runs while the module is being defined — at import time, long
 * before a request exists — so a declaration nobody could have meant fails the
 * process rather than the caller who eventually trips over it.
 */
export function Access(
  declaration: AccessDeclaration,
): CustomDecorator<symbol> {
  assertUsable(declaration);
  return SetMetadata(ACCESS_DECLARATION, declaration);
}

/**
 * Throws unless the declaration could mean something.
 *
 * Exported so the suite that walks every route can ask the same question of
 * what is actually attached, rather than trusting that everything went through
 * `Access` — metadata is data, and a test that re-checks it is checking the
 * application rather than this function.
 */
export function assertUsable(declaration: AccessDeclaration): void {
  const written = JSON.stringify(declaration);
  const refuse = (reason: string): never => {
    throw new Error(`this access declaration ${reason}: ${written}`);
  };

  // Read as an open record. Some of what follows the compiler already refuses;
  // the contradictory combinations it lets through are the reason this is not
  // merely a belt on top of braces.
  const shape = declaration as {
    public?: unknown;
    operator?: unknown;
    person?: unknown;
    roles?: unknown;
    machines?: unknown;
  };
  const names = shape.roles !== undefined;
  const anyPerson = shape.person === true;

  if (shape.public === true) {
    if (anyPerson) {
      refuse(
        'makes a route public and also demands a person, which is a restriction on a route that has none',
      );
    }
    if (names || shape.operator === true || shape.machines === true) {
      refuse('makes a route public and also restricts it, naming roles');
    }
    return;
  }

  if (shape.operator === true) {
    if (anyPerson) {
      refuse(
        'gives a route to an operator and also to any person, which are different admissions: the wider one would decide every request',
      );
    }
    if (shape.machines === true) {
      refuse(
        'gives a route to an operator and also admits machines, which hold no operator status',
      );
    }
    if (names) {
      refuse('mixes operator with roles, which are held by people');
    }
    return;
  }

  if (anyPerson) {
    if (shape.machines === true) {
      refuse(
        'admits any person and also machines, which name a credential rather than a person',
      );
    }
    if (names) {
      refuse(
        'admits any person and also names roles, which are held inside a tenant this shape does not name',
      );
    }
    return;
  }

  if (!names) {
    refuse(
      shape.machines === true
        ? 'admits machines without the roles a key would have to carry'
        : 'states nothing, so nothing can be enforced from it',
    );
  }

  const roles = shape.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    refuse('permits nobody, which a route achieves by declaring nothing');
  }

  const unknown = (roles as unknown[]).filter(
    (role) => !(PERMITTED_ROLES as readonly unknown[]).includes(role),
  );
  if (unknown.length > 0) {
    refuse(`names a role outside ${PERMITTED_ROLES.join(', ')}`);
  }
}
