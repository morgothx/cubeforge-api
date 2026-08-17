import { RandomSecretGenerator } from '../../adapters/crypto/random-secret-generator';
import { InMemoryAuthenticatorUnitOfWork } from '../../adapters/persistence/in-memory/in-memory-authenticator-unit-of-work';
import {
  createIdentityTestContext,
  TEST_MOMENT,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import {
  apiKeyId,
  type PersonId,
  type TenantId,
} from '../../domain/identifiers';
import { IssueApiKeyUseCase } from './issue-api-key.use-case';
import { ListApiKeysUseCase } from './list-api-keys.use-case';
import { RevokeApiKeyUseCase } from './revoke-api-key.use-case';

describe('managing API keys', () => {
  let context: IdentityTestContext;
  let issue: IssueApiKeyUseCase;
  let list: ListApiKeysUseCase;
  let revoke: RevokeApiKeyUseCase;
  let secrets: RandomSecretGenerator;

  beforeEach(() => {
    context = createIdentityTestContext();
    secrets = new RandomSecretGenerator();
    issue = new IssueApiKeyUseCase(
      context.tenantScoped,
      secrets,
      context.clock,
      context.identifiers,
    );
    list = new ListApiKeysUseCase(context.tenantScoped);
    revoke = new RevokeApiKeyUseCase(context.tenantScoped, context.clock);
  });

  async function aTenantWithAdmin(
    name: string,
  ): Promise<{ tenantId: TenantId; admin: PersonId }> {
    const tenantId = await context.seedTenant(name);
    const admin = await context.seedMember({
      tenantId,
      email: `admin-${name}@example.com`,
      role: 'admin',
    });
    return { tenantId, admin };
  }

  it('returns the secret exactly once, and never again', async () => {
    const acme = await aTenantWithAdmin('Acme');
    const actor = context.actingAs(acme.tenantId, acme.admin);

    const issued = await issue.execute({
      actor,
      label: 'inventory sync',
      role: 'editor',
    });

    expect(typeof issued.secret).toBe('string');
    const listed = await list.execute({ actor });
    expect(JSON.stringify(listed)).not.toContain(issued.secret);
    expect(listed[0]).toMatchObject({
      label: 'inventory sync',
      role: 'editor',
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  it('stores only the digest of the secret', async () => {
    const acme = await aTenantWithAdmin('Acme');
    const actor = context.actingAs(acme.tenantId, acme.admin);

    const issued = await issue.execute({
      actor,
      label: 'sync',
      role: 'viewer',
    });

    const authenticator = new InMemoryAuthenticatorUnitOfWork(
      context.credentials,
      context.apiKeys,
    );
    const resolved = await authenticator.runAuthenticating(({ apiKeys }) =>
      apiKeys.resolve(secrets.digest(issued.secret)),
    );
    expect(resolved).toMatchObject({ tenantId: acme.tenantId, role: 'viewer' });
  });

  it('rejects a role outside the permitted set', async () => {
    const acme = await aTenantWithAdmin('Acme');

    await expect(
      issue.execute({
        actor: context.actingAs(acme.tenantId, acme.admin),
        label: 'sync',
        role: 'superuser',
      }),
    ).rejects.toMatchObject({
      error: { kind: 'invalid-role', permitted: ['admin', 'editor', 'viewer'] },
    });
  });

  it('rejects a blank label, naming the field', async () => {
    const acme = await aTenantWithAdmin('Acme');

    await expect(
      issue.execute({
        actor: context.actingAs(acme.tenantId, acme.admin),
        label: '   ',
        role: 'viewer',
      }),
    ).rejects.toMatchObject({
      error: { kind: 'validation', field: 'label' },
    });
  });

  it('shows an administrator only their own tenant keys', async () => {
    const acme = await aTenantWithAdmin('Acme');
    const globex = await aTenantWithAdmin('Globex');
    await issue.execute({
      actor: context.actingAs(acme.tenantId, acme.admin),
      label: 'acme sync',
      role: 'editor',
    });
    await issue.execute({
      actor: context.actingAs(globex.tenantId, globex.admin),
      label: 'globex sync',
      role: 'editor',
    });

    const listed = await list.execute({
      actor: context.actingAs(acme.tenantId, acme.admin),
    });

    expect(listed.map((key) => key.label)).toEqual(['acme sync']);
  });

  it('stops a revoked key from resolving', async () => {
    const acme = await aTenantWithAdmin('Acme');
    const actor = context.actingAs(acme.tenantId, acme.admin);
    const issued = await issue.execute({
      actor,
      label: 'sync',
      role: 'editor',
    });

    await revoke.execute({ actor, apiKeyId: issued.id });

    const authenticator = new InMemoryAuthenticatorUnitOfWork(
      context.credentials,
      context.apiKeys,
    );
    await expect(
      authenticator.runAuthenticating(({ apiKeys }) =>
        apiKeys.resolve(secrets.digest(issued.secret)),
      ),
    ).resolves.toBeNull();
  });

  it('reports a key of another tenant as absent, and leaves it working', async () => {
    const acme = await aTenantWithAdmin('Acme');
    const globex = await aTenantWithAdmin('Globex');
    const theirs = await issue.execute({
      actor: context.actingAs(globex.tenantId, globex.admin),
      label: 'globex sync',
      role: 'editor',
    });

    await expect(
      revoke.execute({
        actor: context.actingAs(acme.tenantId, acme.admin),
        apiKeyId: theirs.id,
      }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });

    const stillListed = await list.execute({
      actor: context.actingAs(globex.tenantId, globex.admin),
    });
    expect(stillListed[0].revokedAt).toBeNull();
  });

  it('reports an unknown key as absent', async () => {
    const acme = await aTenantWithAdmin('Acme');

    await expect(
      revoke.execute({
        actor: context.actingAs(acme.tenantId, acme.admin),
        apiKeyId: apiKeyId('no-such-key'),
      }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });

  it('denies issuing, listing and revoking to a member who is not an administrator', async () => {
    const acme = await aTenantWithAdmin('Acme');
    const viewer = await context.seedMember({
      tenantId: acme.tenantId,
      email: 'viewer@example.com',
      role: 'viewer',
    });
    const issued = await issue.execute({
      actor: context.actingAs(acme.tenantId, acme.admin),
      label: 'sync',
      role: 'editor',
    });
    const actor = context.actingAs(acme.tenantId, viewer);

    for (const attempt of [
      issue.execute({ actor, label: 'theirs', role: 'admin' }),
      list.execute({ actor }),
      revoke.execute({ actor, apiKeyId: issued.id }),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        error: { kind: 'forbidden' },
      });
    }
  });

  /** Requirement 7.9: a key belongs to the tenant, not to whoever created it. */
  it('keeps a key working after its issuer loses their membership', async () => {
    const acme = await aTenantWithAdmin('Acme');
    const second = await context.seedMember({
      tenantId: acme.tenantId,
      email: 'second-admin@example.com',
      role: 'admin',
    });
    const issued = await issue.execute({
      actor: context.actingAs(acme.tenantId, acme.admin),
      label: 'sync',
      role: 'editor',
    });

    const membership = [...context.store.memberships.values()].find(
      (candidate) => candidate.personId === acme.admin,
    );
    context.store.memberships.set(membership!.id, {
      ...membership!,
      status: 'revoked',
    });

    const listed = await list.execute({
      actor: context.actingAs(acme.tenantId, second),
    });
    expect(listed.map((key) => key.id)).toEqual([issued.id]);
    expect(listed[0].revokedAt).toBeNull();
    expect(listed[0].createdAt).toEqual(TEST_MOMENT);
  });
});
