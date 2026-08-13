import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadDatabaseConfig, type DatabaseConfig } from './database-config';

/**
 * Injection tokens for the two runtime identities. They are deliberately
 * separate connections rather than one connection that switches role: the
 * operator identity holds no grant on tenant-owned tables, which is what makes
 * the operator boundary a database guarantee instead of an application promise.
 */
export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');
export const APP_POOL = Symbol('APP_POOL');
export const OPERATOR_POOL = Symbol('OPERATOR_POOL');
export const AUTHENTICATOR_POOL = Symbol('AUTHENTICATOR_POOL');
export const APP_DATABASE = Symbol('APP_DATABASE');
export const OPERATOR_DATABASE = Symbol('OPERATOR_DATABASE');
export const AUTHENTICATOR_DATABASE = Symbol('AUTHENTICATOR_DATABASE');

export type Database = NodePgDatabase<Record<string, never>>;

function poolFor(
  config: DatabaseConfig,
  identity: DatabaseConfig['app'],
): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: identity.user,
    password: identity.password,
  });
}

/**
 * First-party wiring, deliberately not a third-party integrator package: the
 * whole of it is this file, and the available community wrapper has not been
 * published since January 2025.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONFIG,
      useFactory: (): DatabaseConfig => loadDatabaseConfig(process.env),
    },
    {
      provide: APP_POOL,
      inject: [DATABASE_CONFIG],
      useFactory: (config: DatabaseConfig): Pool => poolFor(config, config.app),
    },
    {
      provide: OPERATOR_POOL,
      inject: [DATABASE_CONFIG],
      useFactory: (config: DatabaseConfig): Pool =>
        poolFor(config, config.operator),
    },
    {
      provide: AUTHENTICATOR_POOL,
      inject: [DATABASE_CONFIG],
      useFactory: (config: DatabaseConfig): Pool =>
        poolFor(config, config.authenticator),
    },
    {
      provide: APP_DATABASE,
      inject: [APP_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool),
    },
    {
      provide: OPERATOR_DATABASE,
      inject: [OPERATOR_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool),
    },
    {
      provide: AUTHENTICATOR_DATABASE,
      inject: [AUTHENTICATOR_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool),
    },
  ],
  exports: [
    APP_DATABASE,
    OPERATOR_DATABASE,
    AUTHENTICATOR_DATABASE,
    DATABASE_CONFIG,
  ],
})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(
    @Inject(APP_POOL) private readonly appPool: Pool,
    @Inject(OPERATOR_POOL) private readonly operatorPool: Pool,
    @Inject(AUTHENTICATOR_POOL) private readonly authenticatorPool: Pool,
  ) {}

  /** Without this the process hangs on open sockets after integration runs. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.appPool.end(),
      this.operatorPool.end(),
      this.authenticatorPool.end(),
    ]);
  }
}
