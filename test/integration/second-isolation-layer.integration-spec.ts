import { randomUUID } from 'node:crypto';
import { asPersonInTenant, seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

/**
 * The claim the whole persistence design rests on: two isolation layers that do
 * not share a point of failure.
 *
 * Everywhere else, queries carry an explicit tenant predicate *and* run under a
 * policy that applies the same restriction. Those tests cannot tell which of the
 * two did the work. These deliberately omit the predicate, so what remains is
 * the database alone.
 */
describe('the second isolation layer, on its own', () => {
  useIntegrationDatabase();

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
      for (const [tenant, email] of [
        [acme, 'a@example.com'],
        [globex, 'b@example.com'],
        [globex, 'c@example.com'],
      ] as const) {
        const person = randomUUID();
        await client.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
          person,
          email,
        ]);
        await client.query(
          'INSERT INTO memberships (id, tenant_id, person_id, role) VALUES ($1, $2, $3, $4)',
          [randomUUID(), tenant, person, 'viewer'],
        );
      }
    });
    return { acme, globex };
  }

  it('returns no foreign membership to a query that forgot its predicate', async () => {
    const { acme } = await twoTenantsWithMembers();

    // No WHERE at all. A repository with its scoping removed would issue
    // exactly this.
    const visible = await asPersonInTenant(acme, async (client) => {
      const { rows } = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM memberships',
      );
      return rows;
    });

    expect(visible).toHaveLength(1);
    expect(visible.every((row) => row.tenant_id === acme)).toBe(true);
  });

  it('returns no foreign person to a query that forgot its join', async () => {
    const { acme } = await twoTenantsWithMembers();

    const visible = await asPersonInTenant(acme, async (client) => {
      const { rows } = await client.query<{ email: string }>(
        'SELECT email FROM people',
      );
      return rows;
    });

    expect(visible.map((row) => row.email)).toEqual(['a@example.com']);
  });

  it('returns no foreign tenant to an unqualified read', async () => {
    const { acme } = await twoTenantsWithMembers();

    const visible = await asPersonInTenant(acme, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM tenants',
      );
      return rows;
    });

    expect(visible.map((row) => row.id)).toEqual([acme]);
  });

  it('refuses a write aimed at another tenant even when nothing checks the tenant', async () => {
    const { acme, globex } = await twoTenantsWithMembers();

    const written = await asPersonInTenant(acme, async (client) => {
      const result = await client.query(
        'UPDATE memberships SET role = $1 WHERE tenant_id = $2',
        ['admin', globex],
      );
      return result.rowCount;
    });

    expect(written).toBe(0);
    const untouched = await seed(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM memberships WHERE tenant_id = $1 AND role = 'viewer'",
        [globex],
      );
      return Number(rows[0].count);
    });
    expect(untouched).toBe(2);
  });

  it('cannot insert a membership into another tenant', async () => {
    const { acme, globex } = await twoTenantsWithMembers();
    const person = randomUUID();
    await seed((client) =>
      client.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
        person,
        'smuggled@example.com',
      ]),
    );

    const attempt = asPersonInTenant(acme, (client) =>
      client.query(
        'INSERT INTO memberships (id, tenant_id, person_id, role) VALUES ($1, $2, $3, $4)',
        [randomUUID(), globex, person, 'admin'],
      ),
    );

    await expect(attempt).rejects.toThrow(/row-level security/);
  });
});

/**
 * A guard for the tables that do not exist yet. Later features add their own
 * tenant-owned tables, and the isolation guarantee is only as good as the one
 * that was forgotten.
 */
describe('policy coverage', () => {
  useIntegrationDatabase();

  it('has row-level security enabled and forced on every table', async () => {
    const unprotected = await seed(async (client) => {
      const { rows } = await client.query<{ table: string; reason: string }>(
        `SELECT c.relname AS table,
                CASE WHEN NOT c.relrowsecurity THEN 'not enabled'
                     ELSE 'not forced' END AS reason
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
          ORDER BY c.relname`,
      );
      return rows;
    });

    expect(unprotected).toEqual([]);
  });

  it('has at least one policy on every table', async () => {
    const unpoliced = await seed(async (client) => {
      const { rows } = await client.query<{ table: string }>(
        `SELECT c.relname AS table
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND NOT EXISTS (
              SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
            )
          ORDER BY c.relname`,
      );
      return rows;
    });

    expect(unpoliced).toEqual([]);
  });
});
