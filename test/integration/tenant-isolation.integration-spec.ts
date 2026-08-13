import type { PoolClient } from 'pg';
import {
  asAppWithoutTenant,
  asOperator,
  asPersonInTenant,
} from './support/database';
import {
  seedMember,
  seedTenant,
  useIntegrationDatabase,
} from './support/fixtures';

/**
 * Exercises the harness itself, and with it the isolation guarantee the harness
 * exists to test. Every assertion here goes through one of the runtime
 * identities, so what passes is what the running system would actually see.
 */
describe('tenant isolation, through the harness', () => {
  useIntegrationDatabase();

  async function countMemberships(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memberships',
    );
    return Number(rows[0].count);
  }

  it('shows a tenant only its own memberships', async () => {
    const acme = await seedTenant({ name: 'Acme' });
    const globex = await seedTenant({ name: 'Globex' });
    await seedMember({ tenantId: acme.id, role: 'admin' });
    await seedMember({ tenantId: acme.id, role: 'viewer' });
    await seedMember({ tenantId: globex.id, role: 'admin' });

    const seenByAcme = await asPersonInTenant(acme.id, countMemberships);
    const seenByGlobex = await asPersonInTenant(globex.id, countMemberships);

    expect(seenByAcme).toBe(2);
    expect(seenByGlobex).toBe(1);
  });

  it('shows the same person a different role in each of their tenants', async () => {
    const acme = await seedTenant({ name: 'Acme' });
    const globex = await seedTenant({ name: 'Globex' });
    const person = await seedMember({ tenantId: acme.id, role: 'admin' });
    await seedMember({
      tenantId: globex.id,
      role: 'viewer',
      personId: person.personId,
    });

    const roleIn = async (tenantId: string): Promise<string> =>
      asPersonInTenant(tenantId, async (client) => {
        const { rows } = await client.query<{ role: string }>(
          'SELECT role FROM memberships WHERE person_id = $1',
          [person.personId],
        );
        expect(rows).toHaveLength(1);
        return rows[0].role;
      });

    expect(await roleIn(acme.id)).toBe('admin');
    expect(await roleIn(globex.id)).toBe('viewer');
  });

  it('reveals nothing to a query issued outside a tenant transaction', async () => {
    const acme = await seedTenant({ name: 'Acme' });
    await seedMember({ tenantId: acme.id, role: 'admin' });

    await expect(asAppWithoutTenant(countMemberships)).resolves.toBe(0);
  });

  it('refuses the operator any access to memberships', async () => {
    const acme = await seedTenant({ name: 'Acme' });
    await seedMember({ tenantId: acme.id, role: 'admin' });

    await expect(asOperator(countMemberships)).rejects.toThrow(
      /permission denied for table memberships/,
    );
    // The operator still administers tenants, which is the access it is for.
    await expect(
      asOperator(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM tenants',
        );
        return Number(rows[0].count);
      }),
    ).resolves.toBe(1);
  });

  it('starts each test from an empty database', async () => {
    // Pairs with the test below: whichever runs second proves the reset, and
    // neither can pass by accident because both write the same tenant name,
    // which is unique platform-wide.
    const tenant = await seedTenant({ name: 'Only One Of Me' });
    await seedMember({ tenantId: tenant.id, role: 'admin' });

    await expect(asPersonInTenant(tenant.id, countMemberships)).resolves.toBe(
      1,
    );
  });

  it('starts each test from an empty database, again', async () => {
    const tenant = await seedTenant({ name: 'Only One Of Me' });

    await expect(asPersonInTenant(tenant.id, countMemberships)).resolves.toBe(
      0,
    );
  });
});
