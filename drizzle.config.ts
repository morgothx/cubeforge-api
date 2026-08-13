import { defineConfig } from 'drizzle-kit';
import { loadDatabaseConfig } from './src/adapters/persistence/postgres/database-config';

/**
 * Migrations run as the schema owner, never as a runtime identity. The runtime
 * identities are intentionally not owners, because an owner bypasses row-level
 * security and would make every policy in this schema decorative.
 */
const config = loadDatabaseConfig(process.env);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/adapters/persistence/postgres/schema/*.ts',
  out: './drizzle',
  dbCredentials: {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.migrator.user,
    password: config.migrator.password,
    ssl: false,
  },
});
