import { RandomSecretGenerator } from '../adapters/crypto/random-secret-generator';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../adapters/testing/identity-test-context';
import type { MembershipId, PersonId, TenantId } from '../domain/identifiers';
import type { ActorContext } from './actor-context';
import { IssueApiKeyUseCase } from './api-key/issue-api-key.use-case';
import { ListApiKeysUseCase } from './api-key/list-api-keys.use-case';
import { RevokeApiKeyUseCase } from './api-key/revoke-api-key.use-case';
import { ChangeMemberRoleUseCase } from './membership/change-member-role.use-case';
import { CreateTenantMemberUseCase } from './membership/create-tenant-member.use-case';
import { RevokeMembershipUseCase } from './membership/revoke-membership.use-case';

/**
 * The second layer, with the first one absent entirely.
 *
 * The guard refuses these callers at the edge, and the role matrix shows the
 * system refusing them — but the matrix passes with the guard unregistered,
 * precisely because this layer answers identically. That makes the matrix
 * evidence about the system rather than about either layer, and leaves this
 * claim to be made on its own: **a use case invoked from anywhere other than
 * its route still refuses**.
 *
 * There is no HTTP here, no controller, no declaration and no guard. A queue
 * consumer, a scheduled job or a later feature calling one of these directly
 * gets the same answer a request would, which is the whole reason the check was
 * left in place rather than relocated to the edge.
 */
describe('the second layer, standing on its own', () => {
  let context: IdentityTestContext;
  let acme: TenantId;
  let viewer: PersonId;
  let editor: PersonId;
  let administrator: PersonId;
  let targetMembership: MembershipId;

  beforeEach(async () => {
    context = createIdentityTestContext();
    acme = await context.seedTenant('Acme');
    administrator = await context.seedMember({
      tenantId: acme,
      email: 'admin@acme.example.com',
      role: 'admin',
    });
    editor = await context.seedMember({
      tenantId: acme,
      email: 'editor@acme.example.com',
      role: 'editor',
    });
    viewer = await context.seedMember({
      tenantId: acme,
      email: 'viewer@acme.example.com',
      role: 'viewer',
    });
    const target = [...context.store.memberships.values()].find(
      (candidate) => candidate.personId === viewer,
    );
    if (!target) {
      throw new Error('no membership was seeded for the viewer');
    }
    targetMembership = target.id;
  });

  /** Every operation an administrator alone may perform, invoked directly. */
  function administrativeOperations(
    actor: ActorContext,
  ): readonly [string, () => Promise<unknown>][] {
    const secrets = new RandomSecretGenerator();
    return [
      [
        'adding a member',
        () =>
          new CreateTenantMemberUseCase(
            context.tenantScoped,
            context.clock,
            context.identifiers,
          ).execute({
            actor,
            email: 'newcomer@acme.example.com',
            role: 'viewer',
          }),
      ],
      [
        'changing a role',
        () =>
          new ChangeMemberRoleUseCase(context.tenantScoped).execute({
            actor,
            membershipId: targetMembership,
            role: 'admin',
          }),
      ],
      [
        'revoking a membership',
        () =>
          new RevokeMembershipUseCase(context.tenantScoped).execute({
            actor,
            membershipId: targetMembership,
          }),
      ],
      [
        'issuing an API key',
        () =>
          new IssueApiKeyUseCase(
            context.tenantScoped,
            secrets,
            context.clock,
            context.identifiers,
          ).execute({ actor, label: 'theirs', role: 'viewer' }),
      ],
      [
        'listing API keys',
        () => new ListApiKeysUseCase(context.tenantScoped).execute({ actor }),
      ],
      [
        'revoking an API key',
        () =>
          new RevokeApiKeyUseCase(context.tenantScoped, context.clock).execute({
            actor,
            apiKeyId: context.identifiers.apiKeyId(),
          }),
      ],
    ];
  }

  it.each(['viewer', 'editor'] as const)(
    'refuses a %s every administrative operation, with no route in sight',
    async (role) => {
      const actor: ActorContext = {
        kind: 'tenant-member',
        personId: role === 'viewer' ? viewer : editor,
        tenantId: acme,
      };

      // Collected rather than asserted one at a time, so a failure names the
      // operation that let them through instead of stopping at the first.
      const admitted: string[] = [];
      for (const [operation, invoke] of administrativeOperations(actor)) {
        await invoke().then(
          () => admitted.push(operation),
          (error: unknown) => {
            expect({ operation, error }).toMatchObject({
              operation,
              error: { error: { kind: 'forbidden' } },
            });
          },
        );
      }

      expect(admitted).toEqual([]);
    },
  );

  it('still admits the administrator, so the refusals above mean something', async () => {
    const actor: ActorContext = {
      kind: 'tenant-member',
      personId: administrator,
      tenantId: acme,
    };

    await expect(
      new ListApiKeysUseCase(context.tenantScoped).execute({ actor }),
    ).resolves.toEqual([]);
  });

  it('refuses a machine principal, which holds no membership to check', async () => {
    const actor: ActorContext = {
      kind: 'machine',
      apiKeyId: context.identifiers.apiKeyId(),
      tenantId: acme,
      role: 'admin',
    };

    // The key carries `admin`. A role held by a credential is not a membership,
    // and this layer only knows memberships.
    await expect(
      new ListApiKeysUseCase(context.tenantScoped).execute({ actor }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('refuses a platform operator, who is above this tenant and not in it', async () => {
    await expect(
      new ListApiKeysUseCase(context.tenantScoped).execute({
        actor: context.operator,
      }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });
});
