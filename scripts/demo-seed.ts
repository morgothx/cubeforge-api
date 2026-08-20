import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  Argon2PasswordHasher,
  loadHashingConfig,
} from '../src/adapters/crypto/argon2-password-hasher';
import { loadDatabaseConfig } from '../src/adapters/persistence/postgres/database-config';
import { MINIMUM_PASSWORD_LENGTH } from '../src/domain/credential/password-policy';

/**
 * A platform worth looking at.
 *
 * `bootstrap-operator` is the real entrance and stays the real entrance: it
 * creates one person and hands out a single-use token, which is the smallest
 * thing that opens an empty platform and deliberately no more. What it does not
 * do is produce a *state* — and every screen the dashboard has is about state.
 * A person with no tenant sees the one screen that says they have no tenant.
 *
 * So this exists for demonstrating and for looking at the thing while building
 * it, and it says so in its name. It writes rows directly rather than driving
 * the API, which means it is fast and needs no server running, and which also
 * means it can write a state the domain would refuse. Everything below is a
 * state the domain *would* produce — that is a promise this script keeps by
 * hand, and the reason it stays small.
 *
 * It connects as the **container superuser**, not as the migrator. `FORCE ROW
 * LEVEL SECURITY` subjects even the schema owner to the policies, so there is
 * no ordinary identity that can write another tenant's rows — which is the
 * whole point of the arrangement, and it applies to seeding too. The
 * integration fixtures reach for the same identity for the same reason.
 *
 * What it builds, and why each part is there:
 *
 * - You are an **administrator of Acme and a viewer of Globex**. One tenant
 *   would leave the switcher with nothing to switch to and the role gating with
 *   nothing to compare against. Two, with different roles, is the smallest
 *   arrangement in which both are visible.
 * - You are a **platform operator**, because the badge is a thing the frame
 *   shows and it should be visible at least once.
 * - Acme has an editor, a viewer and a **revoked** member, so the status column
 *   means something and the listing is not three rows of the same thing.
 * - Nobody else gets a password. They are rows in a listing, not people who
 *   sign in, and giving them credentials would imply otherwise.
 */

const DEFAULT_EMAIL = 'founder@example.com';
const DEFAULT_PASSWORD = 'demo-password-please-change';

interface Standing {
  readonly tenant: string;
  readonly role: string;
  readonly members: number;
  readonly revoked: number;
}

interface Seeded {
  readonly email: string;
  readonly password: string;
  readonly standing: readonly Standing[];
}

/**
 * Refuses anything that is not obviously a local database.
 *
 * This script writes fabricated people and prints a password. Neither belongs
 * anywhere that is not a laptop, and a check that costs one line is cheaper
 * than trusting that nobody ever exports the wrong `DATABASE_HOST`.
 */
function refuseUnlessLocal(host: string): void {
  const local = ['localhost', '127.0.0.1', '::1', 'postgres'];
  if (!local.includes(host)) {
    throw new Error(
      `demo-seed refuses to run against "${host}": it fabricates people and prints a password`,
    );
  }
}

async function personNamed(client: Client, email: string): Promise<string> {
  // `DO UPDATE` rather than `DO NOTHING` so the row comes back either way, which
  // is what makes running this twice mean the same as running it once.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO people (id, email, status) VALUES ($1, $2, 'active')
     ON CONFLICT (email) DO UPDATE SET status = 'active'
     RETURNING id`,
    [randomUUID(), email],
  );
  return rows[0].id;
}

async function tenantNamed(client: Client, name: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')
     ON CONFLICT (name) DO UPDATE SET status = 'active'
     RETURNING id`,
    [randomUUID(), name],
  );
  return rows[0].id;
}

async function memberOf(
  client: Client,
  tenantId: string,
  personId: string,
  role: 'admin' | 'editor' | 'viewer',
  status: 'active' | 'revoked' = 'active',
): Promise<void> {
  await client.query(
    `INSERT INTO memberships (id, tenant_id, person_id, role, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, person_id)
     DO UPDATE SET role = excluded.role, status = excluded.status`,
    [randomUUID(), tenantId, personId, role, status],
  );
}

async function operator(client: Client, personId: string): Promise<void> {
  await client.query(
    `INSERT INTO platform_operators (person_id) VALUES ($1)
     ON CONFLICT (person_id) DO NOTHING`,
    [personId],
  );
}

/**
 * Sets a password without the setup-token round trip.
 *
 * The token flow is the real one and has its own tests; making a demo seed walk
 * it would mean standing up the API and copying a secret between two commands
 * to arrive at the same row. What matters here is that the digest is produced
 * by the same hasher the application uses, so the password actually works.
 */
/**
 * The only identity that can seed across tenants.
 *
 * Required rather than defaulted: a silent fallback would turn a missing
 * variable into a confusing row-level-security error several statements later,
 * which is exactly the shape of failure this project keeps trying to avoid.
 */
function superuser(): { user: string; password: string } {
  const user = process.env.POSTGRES_USER?.trim();
  const password = process.env.POSTGRES_PASSWORD?.trim();
  if (!user || !password) {
    throw new Error(
      'POSTGRES_USER and POSTGRES_PASSWORD are required: forced row-level security ' +
        'applies to the schema owner, so seeding needs the local container superuser. ' +
        'They are in .env.example, and docker-compose defaults both to "cubeforge".',
    );
  }
  return { user, password };
}

async function credential(
  client: Client,
  personId: string,
  password: string,
): Promise<void> {
  const hasher = new Argon2PasswordHasher(loadHashingConfig(process.env));
  await client.query(
    `INSERT INTO person_credentials (person_id, password_digest) VALUES ($1, $2)
     ON CONFLICT (person_id) DO UPDATE SET password_digest = excluded.password_digest`,
    [personId, await hasher.hash(password)],
  );
}

export async function seedDemo(
  client: Client,
  email: string,
  password: string,
): Promise<Seeded> {
  const you = await personNamed(client, email);
  await credential(client, you, password);
  await operator(client, you);

  const acme = await tenantNamed(client, 'Acme');
  const globex = await tenantNamed(client, 'Globex');

  await memberOf(client, acme, you, 'admin');
  await memberOf(client, globex, you, 'viewer');

  // Acme's other people. An editor, a viewer, and somebody who used to be here:
  // three rows that differ in the two columns the listing has.
  await memberOf(
    client,
    acme,
    await personNamed(client, 'dana@example.com'),
    'editor',
  );
  await memberOf(
    client,
    acme,
    await personNamed(client, 'sam@example.com'),
    'viewer',
  );
  await memberOf(
    client,
    acme,
    await personNamed(client, 'former@example.com'),
    'viewer',
    'revoked',
  );

  // Globex has its own people, so switching tenants visibly changes the answer
  // rather than showing the same list under a different name.
  await memberOf(
    client,
    globex,
    await personNamed(client, 'rin@example.com'),
    'admin',
  );
  await memberOf(
    client,
    globex,
    await personNamed(client, 'ada@example.com'),
    'editor',
  );

  return { email, password, standing: await standingOf(client, you) };
}

/**
 * What the seeded person will actually see, read back rather than assumed.
 *
 * The first version of this script printed the numbers it intended to create,
 * which were wrong the moment it ran against a database that already had
 * people in it — and a seed reporting fiction is worse than one reporting
 * nothing, because the fiction is what you check the screen against.
 */
async function standingOf(
  client: Client,
  personId: string,
): Promise<Standing[]> {
  const { rows } = await client.query<{
    tenant: string;
    role: string;
    members: string;
    revoked: string;
  }>(
    `SELECT t.name AS tenant,
            mine.role AS role,
            count(*) AS members,
            count(*) FILTER (WHERE all_members.status = 'revoked') AS revoked
       FROM memberships mine
       JOIN tenants t ON t.id = mine.tenant_id
       JOIN memberships all_members ON all_members.tenant_id = t.id
      WHERE mine.person_id = $1 AND mine.status = 'active'
      GROUP BY t.name, mine.role
      ORDER BY t.name`,
    [personId],
  );

  return rows.map((row) => ({
    tenant: row.tenant,
    role: row.role,
    members: Number(row.members),
    revoked: Number(row.revoked),
  }));
}

/**
 *   pnpm ops:demo-seed [email] [password]
 */
async function main(): Promise<void> {
  const [email = DEFAULT_EMAIL, password = DEFAULT_PASSWORD, ...rest] =
    process.argv.slice(2);
  if (rest.length > 0) {
    throw new Error('usage: pnpm ops:demo-seed [email] [password]');
  }
  if ([...password].length < MINIMUM_PASSWORD_LENGTH) {
    // The same rule the platform enforces, checked here so the failure is a
    // sentence now rather than a refused sign-in later.
    throw new Error(
      `password must be at least ${MINIMUM_PASSWORD_LENGTH} characters`,
    );
  }

  const config = loadDatabaseConfig(process.env);
  refuseUnlessLocal(config.host);

  const { user, password: secret } = superuser();
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user,
    password: secret,
  });

  await client.connect();
  try {
    const seeded = await seedDemo(client, email, password);
    process.stdout.write(
      [
        `sign in as         ${seeded.email}`,
        `password           ${seeded.password}`,
        `platform operator  yes`,
        ...seeded.standing.map(
          ({ tenant, role, members, revoked }) =>
            `${role.padEnd(18)} of ${tenant} — ${members} members` +
            (revoked > 0 ? `, ${revoked} revoked` : ''),
        ),
        '',
        'Start the API and the dashboard, then sign in:',
        '  pnpm start:dev                       # in cubeforge-api',
        '  pnpm dev                             # in cubeforge-web',
        '',
      ].join('\n'),
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
