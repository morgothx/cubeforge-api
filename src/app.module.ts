import { Module } from '@nestjs/common';

/**
 * Composition root. This is where ports declared in `application/ports` are
 * bound to their concrete adapters via Nest's DI container. Feature modules
 * are imported here; the domain layer never appears in this file directly.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
