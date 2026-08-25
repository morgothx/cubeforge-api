import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { CorrelationMiddleware } from './adapters/http/correlation.middleware';
import { throttlerOptions } from './adapters/http/credential-throttling';
import {
  inventoryThrottlerOptions,
  loadInventoryThrottlingConfig,
} from './adapters/http/inventory-throttling';
import { PrincipalMiddleware } from './adapters/http/principal.middleware';
import { loadThrottlingConfig } from './adapters/http/throttling.config';
import { AuthenticationModule } from './authentication.module';
import { AuthorizationModule } from './authorization.module';
import { SystemModule } from './system.module';
import { IdentityModule } from './identity.module';
import { InventoryModule } from './inventory.module';

/**
 * Composition root. Ports declared in `application/ports` are bound to their
 * concrete adapters inside each feature module; the domain layer never appears
 * in this file.
 */
@Module({
  imports: [
    /**
     * One registration, here, because `ThrottlerModule` is `@Global` — a second
     * `forRoot` anywhere would not add buckets, it would replace them, and the
     * credential limits would disappear without a single test noticing.
     *
     * Every bucket is therefore visible to every throttled handler, and each
     * one skips the buckets that are not its own. That is explicit rather than
     * clever, and it is why the bucket names are exported constants.
     */
    ThrottlerModule.forRoot([
      ...throttlerOptions(loadThrottlingConfig(process.env)),
      ...inventoryThrottlerOptions(loadInventoryThrottlingConfig(process.env)),
    ]),
    SystemModule,
    AuthenticationModule,
    AuthorizationModule,
    IdentityModule,
    InventoryModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Registered everywhere, including production. The principal middleware's
    // predecessor could not be: it read the principal from headers and believed
    // it, so it existed behind an environment check. There is nothing to guard
    // against here — this one verifies a credential before it means anything.
    //
    // The order is the point: a correlation identifier has to exist before
    // anything can log against it, and a refused credential is the first thing
    // worth logging.
    consumer
      .apply(CorrelationMiddleware, PrincipalMiddleware)
      .forRoutes('*path');
  }
}
