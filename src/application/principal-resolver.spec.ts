import {
  type AccessToken,
  accessToken,
  opaqueSecret,
  secretDigest,
  type OpaqueSecret,
} from '../domain/credential/secrets';
import { personId, tenantId, type PersonId } from '../domain/identifiers';
import type { PersonStatus } from '../domain/person/person.entity';
import { InMemoryApiKeyStore } from '../adapters/persistence/in-memory/in-memory-api-key-store';
import { InMemoryAuthenticatorUnitOfWork } from '../adapters/persistence/in-memory/in-memory-authenticator-unit-of-work';
import { InMemoryCredentialStore } from '../adapters/persistence/in-memory/in-memory-credential-store';
import { FixedClock } from '../adapters/testing/fixed-clock';
import type { AccessTokenIssuer } from './ports/access-token-issuer';
import type { SecretGenerator } from './ports/secret-generator';
import { PrincipalResolver } from './principal-resolver';

const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * What the resolver makes of a verified token, which is the whole of its job on
 * a path that names no tenant.
 *
 * The interesting cases are all absences: a person the platform no longer
 * counts as active, and an operator record belonging to one. Both have to end
 * in no principal, and until this feature there was no way to tell them apart
 * from an ordinary member — because an ordinary member resolved to nothing too.
 */
describe('resolving a principal from an access token', () => {
  const somebody = personId('11111111-1111-4111-8111-111111111111');
  const acme = tenantId('22222222-2222-4222-8222-222222222222');

  /**
   * Only `verify` is exercised: the resolver takes the person from the token
   * and nothing else, which requirement 4.3 states and this stub makes
   * structural — there is nowhere else for a claim to come from.
   */
  const tokens: AccessTokenIssuer = {
    issue: (): Promise<AccessToken> => Promise.resolve(accessToken('unused')),
    verify: (token: string): Promise<PersonId | null> =>
      Promise.resolve(token === 'valid' ? somebody : null),
  };

  const secrets: SecretGenerator = {
    generate: (): OpaqueSecret => opaqueSecret('unused'),
    digest: (): ReturnType<typeof secretDigest> => secretDigest('unused'),
  };

  function resolverFor(input: {
    readonly status: PersonStatus | 'unknown';
    readonly operator: boolean;
  }): PrincipalResolver {
    const person =
      input.status === 'unknown'
        ? null
        : { id: somebody, status: input.status };
    const store = new InMemoryCredentialStore({
      byEmail: () => null,
      byId: (id) => (id === somebody ? person : null),
    });
    if (input.operator) {
      store.operators.add(somebody);
    }
    return new PrincipalResolver(
      tokens,
      new InMemoryAuthenticatorUnitOfWork(store, new InMemoryApiKeyStore()),
      secrets,
      new FixedClock(NOW),
    );
  }

  function resolve(
    resolver: PrincipalResolver,
    tenant: ReturnType<typeof tenantId> | null = null,
  ) {
    return resolver.resolve({
      scheme: 'access-token',
      token: 'valid',
      tenantId: tenant,
    });
  }

  it('resolves an active person who is no operator, acting in no tenant', async () => {
    const resolver = resolverFor({ status: 'active', operator: false });

    // The kind that did not exist. Before it, this caller resolved to nothing
    // at all, and every tenantless route was closed to them by the shape of
    // the resolver rather than by any rule.
    await expect(resolve(resolver)).resolves.toEqual({
      kind: 'person',
      personId: somebody,
    });
  });

  it('still resolves an active operator as an operator', async () => {
    const resolver = resolverFor({ status: 'active', operator: true });

    await expect(resolve(resolver)).resolves.toEqual({
      kind: 'platform-operator',
      personId: somebody,
    });
  });

  it('resolves a deactivated person to nobody, operator record or not', async () => {
    // Both directions matter. Deactivating a person has to end their access as
    // an operator — feature 2 asserts that much — and it now also has to keep
    // them from reaching a tenantless route as a plain person, which is a
    // door that did not exist to close before.
    for (const operator of [false, true]) {
      const resolver = resolverFor({ status: 'deactivated', operator });

      await expect(resolve(resolver)).resolves.toBeNull();
    }
  });

  it('resolves a token naming a person the platform does not know to nobody', async () => {
    const resolver = resolverFor({ status: 'unknown', operator: false });

    await expect(resolve(resolver)).resolves.toBeNull();
  });

  it('still resolves a tenant member when the path names a tenant', async () => {
    const resolver = resolverFor({ status: 'active', operator: false });

    // Unchanged, and deliberately: one person may act in several tenants, and
    // which tenant comes from the path. The new kind is what a request that
    // named none resolves to, never a substitute for this one.
    await expect(resolve(resolver, acme)).resolves.toEqual({
      kind: 'tenant-member',
      personId: somebody,
      tenantId: acme,
    });
  });

  it('resolves a token it cannot verify to nobody', async () => {
    const resolver = resolverFor({ status: 'active', operator: false });

    await expect(
      resolver.resolve({
        scheme: 'access-token',
        token: 'forged',
        tenantId: null,
      }),
    ).resolves.toBeNull();
  });
});
