import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { configure } from '../../main';
import type { AccessTokenIssuer } from '../../application/ports/access-token-issuer';
import { ACCESS_TOKEN_ISSUER } from '../../application/ports/access-token-issuer';
import { AUTHENTICATOR_UNIT_OF_WORK } from '../../application/ports/authenticator-unit-of-work';
import { CLOCK } from '../../application/ports/clock';
import { IDENTIFIER_GENERATOR } from '../../application/ports/identifier-generator';
import type { PasswordHasher } from '../../application/ports/password-hasher';
import { PASSWORD_HASHER } from '../../application/ports/password-hasher';
import { PLATFORM_UNIT_OF_WORK } from '../../application/ports/platform-unit-of-work';
import { TENANT_SCOPED_UNIT_OF_WORK } from '../../application/ports/tenant-scoped-unit-of-work';
import { throttlerOptions } from '../http/credential-throttling';
import type { ThrottlingConfig } from '../http/throttling.config';
import { InMemoryAuthenticatorUnitOfWork } from '../persistence/in-memory/in-memory-authenticator-unit-of-work';
import {
  APP_DATABASE,
  AUTHENTICATOR_DATABASE,
  DATABASE_CONFIG,
  DrizzleModule,
  OPERATOR_DATABASE,
} from '../persistence/postgres/drizzle.module';
import type { IdentityTestContext } from './identity-test-context';

/**
 * Stands in for the module that opens connection pools.
 *
 * It provides the same tokens and nothing behind them: every unit of work is
 * replaced below, so nothing ever asks for a database. Overriding the module
 * rather than its providers also keeps `loadDatabaseConfig` from running, which
 * would otherwise demand a full set of connection variables from a suite that
 * has no database to connect to.
 */
@Global()
@Module({
  providers: [
    { provide: DATABASE_CONFIG, useValue: null },
    { provide: APP_DATABASE, useValue: null },
    { provide: OPERATOR_DATABASE, useValue: null },
    { provide: AUTHENTICATOR_DATABASE, useValue: null },
  ],
  exports: [
    DATABASE_CONFIG,
    APP_DATABASE,
    OPERATOR_DATABASE,
    AUTHENTICATOR_DATABASE,
  ],
})
class NoDatabaseModule {}

export interface InMemoryApplicationOptions {
  readonly context: IdentityTestContext;
  /** Argon2 is real but cheap here; the cost is tested where cost is the point. */
  readonly hasher: PasswordHasher;
  readonly tokens: AccessTokenIssuer;
  /** Small limits, so a test can exhaust a bucket in a few requests. */
  readonly throttling: ThrottlingConfig;
}

/**
 * The real application, with the database swapped for memory and nothing else.
 *
 * This exists because the alternative — a test module that lists the same
 * controllers and providers by hand — passes just as happily when the real
 * composition root is missing one of them. Booting `AppModule` means the suite
 * notices a controller nobody registered, a middleware nobody applied, a pipe
 * that was never global; and `configure` is imported from `main.ts` rather than
 * repeated, so what these tests exercise is what runs.
 *
 * Every substitution is a port token. That is the whole payoff of the boundary,
 * and it is why this function is short.
 */
export async function createInMemoryApplication(
  options: InMemoryApplicationOptions,
): Promise<INestApplication<App>> {
  const { context } = options;
  const authenticator = new InMemoryAuthenticatorUnitOfWork(
    context.credentials,
    // The same store the tenant-scoped unit of work writes to, so a key issued
    // through a route is a key that can then authenticate.
    context.apiKeys,
  );

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideModule(DrizzleModule)
    .useModule(NoDatabaseModule)
    .overrideProvider(TENANT_SCOPED_UNIT_OF_WORK)
    .useValue(context.tenantScoped)
    .overrideProvider(PLATFORM_UNIT_OF_WORK)
    .useValue(context.platform)
    .overrideProvider(AUTHENTICATOR_UNIT_OF_WORK)
    .useValue(authenticator)
    .overrideProvider(CLOCK)
    .useValue(context.clock)
    .overrideProvider(IDENTIFIER_GENERATOR)
    .useValue(context.identifiers)
    .overrideProvider(PASSWORD_HASHER)
    .useValue(options.hasher)
    .overrideProvider(ACCESS_TOKEN_ISSUER)
    .useValue(options.tokens)
    // The throttling limits are read from the environment at module definition
    // time, which a test cannot influence — so the resolved options are
    // replaced instead.
    .overrideProvider(getOptionsToken())
    .useValue(throttlerOptions(options.throttling))
    .compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configure(app);
  await app.init();
  return app;
}
