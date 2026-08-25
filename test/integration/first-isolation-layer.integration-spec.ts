import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresTenantScopedUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import {
  membershipId as toMembershipId,
  personId as toPersonId,
  tenantId as toTenantId,
} from '../../src/domain/identifiers';
import {
  externalMovementId,
  locationCode,
  sku,
} from '../../src/domain/inventory/identifiers';
import { policyBypassingPool, seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

/**
 * The mirror image of `second-isolation-layer.integration-spec.ts`.
 *
 * That suite removes the application's tenant predicate to show the database
 * still holds. This one removes the database's protection — by connecting as a
 * superuser, whom policies do not apply to — to show the repositories hold on
 * their own. Between the two, neither layer can be credited for the other's
 * work, which is the entire claim.
 *
 * It also gives the role matrix the sensitivity it is supposed to have. With
 * policies in force, deleting a repository's tenant predicate breaks nothing
 * observable, so the matrix alone cannot notice. These tests do.
 */
describe('the first isolation layer, on its own', () => {
  useIntegrationDatabase();

  const unitOfWork = new PostgresTenantScopedUnitOfWork(
    drizzle(policyBypassingPool()),
  );

  async function twoTenantsWithMembers(): Promise<{
    acme: string;
    globex: string;
  }> {
    const acme = randomUUID();
    const globex = randomUUID();
    await seed(async (client) => {
      await client.query(
        'INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)',
        [acme, 'Acme', globex, 'Globex'],
      );
      for (const [tenant, email, role] of [
        [acme, 'a@example.com', 'admin'],
        [globex, 'b@example.com', 'admin'],
        [globex, 'c@example.com', 'viewer'],
      ] as const) {
        const person = randomUUID();
        await client.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
          person,
          email,
        ]);
        await client.query(
          'INSERT INTO memberships (id, tenant_id, person_id, role) VALUES ($1, $2, $3, $4)',
          [randomUUID(), tenant, person, role],
        );
      }
    });
    return { acme, globex };
  }

  it('lists only this tenant members with policies switched off', async () => {
    const { acme } = await twoTenantsWithMembers();

    const members = await unitOfWork.runInTenant(
      toTenantId(acme),
      ({ memberships }) => memberships.listMembers({ includeInactive: true }),
    );

    expect(members.map((member) => member.email)).toEqual(['a@example.com']);
  });

  it('does not resolve a membership from another tenant by identifier', async () => {
    const { acme, globex } = await twoTenantsWithMembers();
    const foreign = await seed(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM memberships WHERE tenant_id = $1 LIMIT 1',
        [globex],
      );
      return rows[0].id;
    });

    const found = await unitOfWork.runInTenant(
      toTenantId(acme),
      ({ memberships }) => memberships.findById(toMembershipId(foreign)),
    );

    expect(found).toBeNull();
  });

  it('counts only this tenant administrators', async () => {
    const { acme } = await twoTenantsWithMembers();

    const count = await unitOfWork.runInTenant(
      toTenantId(acme),
      ({ memberships }) => memberships.countActiveAdministrators(),
    );

    // Globex has an administrator too; counting it would let one tenant's
    // membership satisfy another tenant's last-administrator invariant.
    expect(count).toBe(1);
  });

  it('does not resolve a person who belongs only to another tenant', async () => {
    const { acme, globex } = await twoTenantsWithMembers();
    const outsider = await seed(async (client) => {
      const { rows } = await client.query<{ person_id: string }>(
        'SELECT person_id FROM memberships WHERE tenant_id = $1 LIMIT 1',
        [globex],
      );
      return rows[0].person_id;
    });

    const found = await unitOfWork.runInTenant(toTenantId(acme), ({ people }) =>
      people.findById(toPersonId(outsider)),
    );

    expect(found).toBeNull();
  });

  it('does not read another tenant record as the current one', async () => {
    const { acme } = await twoTenantsWithMembers();

    const current = await unitOfWork.runInTenant(
      toTenantId(acme),
      ({ tenants }) => tenants.findCurrent(),
    );

    expect(current?.name).toBe('Acme');
  });

  /**
   * Inventory joins this suite now that the unit of work carries it.
   *
   * Until it did, these repositories asserted the same claim in their own
   * files. This is where it belongs: one place that answers "does the
   * application scope its own reads" for every tenant-owned table at once, so a
   * table added later without a predicate is a gap somebody notices here.
   */
  describe('inventory', () => {
    async function twoTenantsWithStock(): Promise<{
      acme: string;
      globex: string;
    }> {
      const { acme, globex } = await twoTenantsWithMembers();
      for (const [tenant, code] of [
        [acme, 'ACME-1'],
        [globex, 'GLOBEX-9'],
      ] as const) {
        await unitOfWork.runInTenant(
          toTenantId(tenant),
          async ({ products, locations, movements }) => {
            await products.declare(sku(code), { name: code, category: null });
            await locations.declare(locationCode('WH-1'), { name: 'Main' });
            await movements.record([
              {
                externalId: externalMovementId(`ERP-${code}`),
                sku: sku(code),
                location: locationCode('WH-1'),
                kind: 'receipt',
                quantity: 5,
                occurredAt: new Date('2026-08-25T10:00:00.000Z'),
              },
            ]);
          },
        );
      }
      return { acme, globex };
    }

    it('lists only this tenant products with policies switched off', async () => {
      const { acme } = await twoTenantsWithStock();

      const listed = await unitOfWork.runInTenant(
        toTenantId(acme),
        ({ products }) => products.list(),
      );

      expect(listed.map((product) => product.code)).toEqual(['ACME-1']);
    });

    it('does not admit that another tenant declared a SKU', async () => {
      const { acme } = await twoTenantsWithStock();

      const known = await unitOfWork.runInTenant(
        toTenantId(acme),
        ({ products }) => products.declared([sku('GLOBEX-9')]),
      );

      expect(known).toEqual(new Set());
    });

    it('lists only this tenant places', async () => {
      const { acme } = await twoTenantsWithStock();

      const listed = await unitOfWork.runInTenant(
        toTenantId(acme),
        ({ locations }) => locations.list(),
      );

      // Both tenants declared `WH-1`. Counting theirs would be the same failure
      // as counting their administrators.
      expect(listed).toHaveLength(1);
    });

    it('sums only this tenant movements', async () => {
      const { acme } = await twoTenantsWithStock();

      const stock = await unitOfWork.runInTenant(
        toTenantId(acme),
        ({ movements }) => movements.stockOnHand(),
      );

      expect(stock).toEqual([{ sku: 'ACME-1', location: 'WH-1', onHand: 5 }]);
    });
  });
});
