import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { createActorContextMiddleware } from './adapters/http/actor-context.middleware';
import { IdentityModule } from './identity.module';

/**
 * Composition root. Ports declared in `application/ports` are bound to their
 * concrete adapters inside each feature module; the domain layer never appears
 * in this file.
 */
@Module({
  imports: [IdentityModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Registered only outside production. The middleware itself refuses to be
    // built there, so a mistake in this condition fails at startup rather than
    // silently accepting forged actors.
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    consumer
      .apply(createActorContextMiddleware(process.env.NODE_ENV))
      .forRoutes('*path');
  }
}
