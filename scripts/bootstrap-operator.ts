import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { RandomSecretGenerator } from '../src/adapters/crypto/random-secret-generator';
import { loadDatabaseConfig } from '../src/adapters/persistence/postgres/database-config';
import { setupTokenDeadline } from '../src/domain/credential/setup-token';

export interface BootstrappedOperator {
  readonly personId: string;
  readonly email: string;
  readonly setupToken: string;
  readonly expiresAt: Date;
  /** False when the person, the operator record and a usable token all existed. */
  readonly created: boolean;
}

/**
 * The first way in.
 *
 * `grant-operator` deliberately refuses an address it cannot find, so a typo
 * cannot leave a dangling operator record. That guard is right, and it also
 * means an empty platform has no entrance: no route creates a person without an
 * operator, and no operator can obtain a password without another operator
 * issuing them a setup token. This closes that circle, and only that circle.
 *
 * It is a separate command rather than a flag on `grant-operator` because it
 * does something categorically different — it *creates* — and naming it for
 * what it is keeps the everyday command strict.
 *
 * Run as the migration identity, which is the same authority that owns the
 * schema. Requirement 11.5 places the root of trust here rather than behind any
 * route, so nothing the API exposes can promote its own caller.
 */
export async function bootstrapOperator(
  client: Client,
  email: string,
  now: Date,
): Promise<BootstrappedOperator> {
  const secrets = new RandomSecretGenerator();
  const token = secrets.generate();
  const expiresAt = setupTokenDeadline(now);

  // Idempotent in all three steps, so a replayed provisioning run is a no-op
  // plus a fresh token rather than an error.
  const { rows } = await client.query<{ id: string; created: boolean }>(
    `WITH existing AS (
       SELECT id FROM people WHERE email = $2::citext
     ), inserted AS (
       INSERT INTO people (id, email)
       SELECT $1, $2::citext
        WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     )
     SELECT id, true AS created FROM inserted
     UNION ALL
     SELECT id, false AS created FROM existing`,
    [randomUUID(), email],
  );
  const person = rows[0];

  await client.query(
    `INSERT INTO platform_operators (person_id) VALUES ($1)
     ON CONFLICT (person_id) DO NOTHING`,
    [person.id],
  );

  // A new token every run. The platform stores only a digest and cannot
  // reproduce what it issued, so "print the one from last time" is not an
  // option the design leaves open.
  await client.query(
    `INSERT INTO credential_setup_tokens (id, person_id, secret_digest, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), person.id, secrets.digest(token), expiresAt],
  );

  return {
    personId: person.id,
    email,
    setupToken: token,
    expiresAt,
    created: person.created,
  };
}

/**
 *   pnpm ops:bootstrap-operator founder@example.com
 */
async function main(): Promise<void> {
  const [email, ...rest] = process.argv.slice(2);
  if (!email || rest.length > 0) {
    throw new Error('usage: pnpm ops:bootstrap-operator <email>');
  }

  const config = loadDatabaseConfig(process.env);
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.migrator.user,
    password: config.migrator.password,
  });

  await client.connect();
  try {
    const result = await bootstrapOperator(client, email, new Date());
    process.stdout.write(
      [
        result.created
          ? `created ${email} as person ${result.personId}`
          : `${email} already existed as person ${result.personId}`,
        `${email} is a platform operator`,
        // The one secret this project ever prints. It is single-use, expires,
        // and buys nothing on its own — the holder still has to choose a
        // password through POST /auth/credentials.
        `setup token: ${result.setupToken}`,
        `redeem it before ${result.expiresAt.toISOString()} with:`,
        `  POST /auth/credentials {"token": "…", "password": "…"}`,
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
