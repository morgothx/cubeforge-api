import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core';
import type { App } from 'supertest/types';
import { ISSUE_API_KEY_ROLES } from '../../../application/api-key/issue-api-key.use-case';
import { LIST_API_KEYS_ROLES } from '../../../application/api-key/list-api-keys.use-case';
import { REVOKE_API_KEY_ROLES } from '../../../application/api-key/revoke-api-key.use-case';
import { DECLARE_LOCATION_ROLES } from '../../../application/inventory/declare-location.use-case';
import { DECLARE_PRODUCT_ROLES } from '../../../application/inventory/declare-product.use-case';
import { LIST_LOCATIONS_ROLES } from '../../../application/inventory/list-locations.use-case';
import { LIST_PRODUCTS_ROLES } from '../../../application/inventory/list-products.use-case';
import { CHANGE_MEMBER_ROLE_ROLES } from '../../../application/membership/change-member-role.use-case';
import { CREATE_TENANT_MEMBER_ROLES } from '../../../application/membership/create-tenant-member.use-case';
import { LIST_TENANT_MEMBERS_ROLES } from '../../../application/membership/list-tenant-members.use-case';
import { REVOKE_MEMBERSHIP_ROLES } from '../../../application/membership/revoke-membership.use-case';
import type { Role } from '../../../domain/membership/role';
import { Argon2PasswordHasher } from '../../crypto/argon2-password-hasher';
import { JwtAccessTokenIssuer } from '../../crypto/access-token-issuer';
import { createIdentityTestContext } from '../../testing/identity-test-context';
import { createInMemoryApplication } from '../../testing/in-memory-application';
import { RouteInventory, type DeclaredRoute } from './route-inventory';

/**
 * The two layers say the same thing, and nothing yet stops them drifting apart.
 *
 * A route declares the roles it admits; the use case behind it enforces its own
 * list. They are deliberately **not** one shared constant — two layers reading
 * one value would be a single point of failure wearing two hats, and a wrong
 * value would then be wrong in both places at once. This is what keeps them
 * honest instead: an accidental divergence fails here, while a deliberate one
 * has to be written twice, which is exactly the friction a security rule
 * deserves.
 *
 * Nothing in the running system links a route to the use case behind it, so the
 * pairing is stated here. That is not a third list to keep in step: the
 * constants are imported, so renaming or deleting one fails the build rather
 * than this test.
 */
describe('the declared roles and the enforced roles', () => {
  const tokens = new JwtAccessTokenIssuer({
    secret: 'a-signing-secret-long-enough-for-the-rule',
    accessTokenLifetimeSeconds: 900,
  });
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });

  /** Route → the roles the use case behind it enforces. */
  const ENFORCED: Readonly<Record<string, readonly Role[]>> = {
    'GET /tenants/:tenantId/members': LIST_TENANT_MEMBERS_ROLES,
    'PUT /tenants/:tenantId/inventory/products/:sku': DECLARE_PRODUCT_ROLES,
    'GET /tenants/:tenantId/inventory/products': LIST_PRODUCTS_ROLES,
    'PUT /tenants/:tenantId/inventory/locations/:code': DECLARE_LOCATION_ROLES,
    'GET /tenants/:tenantId/inventory/locations': LIST_LOCATIONS_ROLES,
    'POST /tenants/:tenantId/members': CREATE_TENANT_MEMBER_ROLES,
    'PATCH /tenants/:tenantId/members/:membershipId': CHANGE_MEMBER_ROLE_ROLES,
    'DELETE /tenants/:tenantId/members/:membershipId': REVOKE_MEMBERSHIP_ROLES,
    'POST /tenants/:tenantId/api-keys': ISSUE_API_KEY_ROLES,
    'GET /tenants/:tenantId/api-keys': LIST_API_KEYS_ROLES,
    'DELETE /tenants/:tenantId/api-keys/:apiKeyId': REVOKE_API_KEY_ROLES,
  };

  /**
   * Route → the use case that must require a platform operator. There is no
   * value to compare here, only a call, so this is a presence check against the
   * source. Coarse on purpose: it fails if the requirement disappears, which is
   * the drift worth catching, and a rename is a one-line fix.
   */
  const OPERATOR_ROUTES: Readonly<Record<string, string>> = {
    'POST /tenants': 'tenant/provision-tenant.use-case.ts',
    'GET /tenants': 'tenant/list-tenants.use-case.ts',
    'DELETE /tenants/:tenantId': 'tenant/deactivate-tenant.use-case.ts',
    'DELETE /platform/people/:personId': 'person/deactivate-person.use-case.ts',
    'POST /platform/people/:personId/setup-tokens':
      'credential/issue-setup-token.use-case.ts',
  };

  /**
   * Route → the use case that must refuse any actor naming no person acting
   * alone. A presence check against the source, like the operator one: there
   * is no value to compare, only a call.
   *
   * Added in `caller-identity` task 4.3, and the task predicted this file would
   * fail when `GET /me` appeared. It did not — both pairings below filter on
   * `roles` and on `operator`, so a route declaring `{ person: true }` escaped
   * the drift check entirely, which is precisely the hole this file exists to
   * close. The new declaration needed a pairing of its own, not an exemption.
   */
  const PERSON_ROUTES: Readonly<Record<string, string>> = {
    'GET /me': 'identity/describe-caller.use-case.ts',
  };

  let app: INestApplication<App>;
  let routes: readonly DeclaredRoute[];

  beforeAll(async () => {
    app = await createInMemoryApplication({
      context: createIdentityTestContext(),
      hasher,
      tokens,
      throttling: {
        windowSeconds: 60,
        cooldownSeconds: 60,
        signInAttemptsPerAddress: 3,
        signInAttemptsPerOrigin: 8,
        redemptionsPerOrigin: 3,
      },
    });
    routes = new RouteInventory(
      new DiscoveryService(app.get(ModulesContainer)),
      new MetadataScanner(),
      new Reflector(),
    ).all();
  });

  afterAll(async () => {
    await app.close();
  });

  function declarationOf(route: string): unknown {
    const found = routes.find(
      (candidate) => `${candidate.method} ${candidate.path}` === route,
    );
    if (found === undefined) {
      throw new Error(`no route in the application matches ${route}`);
    }
    return found.declaration;
  }

  it.each(Object.keys(ENFORCED))(
    'declares on %s exactly what its use case enforces',
    (route) => {
      const declaration = declarationOf(route);

      // The roles compared exactly — that is the drift this suite exists to
      // catch. `machines` is a separate admission a route makes, and comparing
      // the whole object would have meant no machine route could ever be paired
      // here. Which keys may appear at all is settled by `assertUsable`, and
      // that nothing but inventory sets `machines` is settled by the route
      // inventory; this asserts the one thing neither of those does.
      expect(declaration).toMatchObject({ roles: [...ENFORCED[route]] });

      const keys = Object.keys(declaration ?? {}).sort();
      expect(keys).toEqual(
        keys.includes('machines') ? ['machines', 'roles'] : ['roles'],
      );
    },
  );

  it.each(Object.keys(OPERATOR_ROUTES))(
    'declares %s for an operator, and its use case demands one',
    (route) => {
      expect(declarationOf(route)).toEqual({ operator: true });

      const source = readFileSync(
        join(__dirname, '../../../application', OPERATOR_ROUTES[route]),
        'utf8',
      );
      // The call, not the identifier: the import line mentions it too, so
      // grepping for the name alone was satisfied by an unused import and
      // survived deleting the call. Found by breaking it.
      expect(source).toContain('requirePlatformOperator(');
    },
  );

  it.each(Object.keys(PERSON_ROUTES))(
    'declares %s for any person, and its use case still refuses the other kinds',
    (route) => {
      expect(declarationOf(route)).toEqual({ person: true });

      const source = readFileSync(
        join(__dirname, '../../../application', PERSON_ROUTES[route]),
        'utf8',
      );
      // The guard admits a person and an operator. The use case must not
      // simply trust that: a machine or a tenant member reaching it through
      // some later route would otherwise be answered.
      expect(source).toContain('callerPersonOf(');
    },
  );

  it('pairs every route declared for any person with a use case', () => {
    const anyPerson = routes
      .filter(
        (route) => route.declaration !== null && 'person' in route.declaration,
      )
      .map((route) => `${route.method} ${route.path}`);

    expect(anyPerson.sort()).toEqual(Object.keys(PERSON_ROUTES).sort());
  });

  it('pairs every route that names roles with a use case', () => {
    // Otherwise a route added later could name roles and quietly escape the
    // comparison above, which is the failure this whole file exists to prevent.
    const naming = routes
      .filter(
        (route) => route.declaration !== null && 'roles' in route.declaration,
      )
      .map((route) => `${route.method} ${route.path}`);

    expect(naming.sort()).toEqual(Object.keys(ENFORCED).sort());
  });

  it('pairs every route declared for an operator with a use case', () => {
    const operatorOnly = routes
      .filter(
        (route) =>
          route.declaration !== null && 'operator' in route.declaration,
      )
      .map((route) => `${route.method} ${route.path}`);

    expect(operatorOnly.sort()).toEqual(Object.keys(OPERATOR_ROUTES).sort());
  });
});
