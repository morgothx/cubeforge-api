import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { PrincipalMiddleware } from './adapters/http/principal.middleware';
import { AuthenticationModule } from './authentication.module';
import { SystemModule } from './system.module';
import { IdentityModule } from './identity.module';

/**
 * Composition root. Ports declared in `application/ports` are bound to their
 * concrete adapters inside each feature module; the domain layer never appears
 * in this file.
 */
@Module({
  imports: [SystemModule, AuthenticationModule, IdentityModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Registered everywhere, including production. Its predecessor could not be:
    // it read the principal from headers and believed it, so it existed behind
    // an environment check. There is nothing to guard against here — this one
    // verifies a credential before it means anything.
    consumer.apply(PrincipalMiddleware).forRoutes('*path');
  }
}
