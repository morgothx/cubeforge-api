import { Client } from 'pg';
import { loadDatabaseConfig } from '../src/adapters/persistence/postgres/database-config';

/**
 * Records an existing person as a platform operator, or withdraws that status.
 *
 * This lives outside the API on purpose. Operators sit above every tenant, so an
 * endpoint that could promote its own caller would leave the platform with no
 * ceiling — requirement 11.5 forbids one. The authority to run this is the
 * authority to run migrations, which is the same root of trust the schema
 * already rests on.
 *
 *   pnpm ops:grant-operator someone@example.com
 *   pnpm ops:grant-operator someone@example.com --withdraw
 */
async function main(): Promise<void> {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    throw new Error(
      'usage: pnpm ops:grant-operator <email> [--withdraw]',
    );
  }
  const withdrawing = flag === '--withdraw';
  if (flag !== undefined && !withdrawing) {
    throw new Error(`unknown option "${flag}"; the only option is --withdraw`);
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
    // Resolved rather than trusted: granting operator status to an address that
    // does not exist would leave a row nobody can use and no error to notice.
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM people WHERE email = $1::citext',
      [email],
    );
    const person = rows[0];
    if (!person) {
      throw new Error(`no person on this platform has the address ${email}`);
    }

    if (withdrawing) {
      const result = await client.query(
        'DELETE FROM platform_operators WHERE person_id = $1',
        [person.id],
      );
      process.stdout.write(
        result.rowCount === 0
          ? `${email} was not an operator; nothing changed\n`
          : `${email} is no longer a platform operator\n`,
      );
      return;
    }

    // Idempotent: running it twice is a no-op rather than an error, so it is
    // safe in a provisioning script that may be replayed.
    const result = await client.query(
      `INSERT INTO platform_operators (person_id) VALUES ($1)
       ON CONFLICT (person_id) DO NOTHING`,
      [person.id],
    );
    process.stdout.write(
      result.rowCount === 0
        ? `${email} was already a platform operator; nothing changed\n`
        : `${email} is now a platform operator\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
