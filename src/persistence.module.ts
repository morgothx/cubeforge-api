import { Module } from '@nestjs/common';
import { DrizzleModule } from './adapters/persistence/postgres/drizzle.module';
import { PostgresPlatformUnitOfWork } from './adapters/persistence/postgres/postgres-platform-unit-of-work';
import { PostgresTenantScopedUnitOfWork } from './adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { PLATFORM_UNIT_OF_WORK } from './application/ports/platform-unit-of-work';
import { TENANT_SCOPED_UNIT_OF_WORK } from './application/ports/tenant-scoped-unit-of-work';

/**
 * The two units of work that are not authentication's own.
 *
 * They lived in the identity module until authentication needed them too:
 * issuing a setup token runs as an operator, and issuing an API key runs inside
 * a tenant. Binding them twice would have worked and would eventually have
 * drifted. Exported explicitly rather than made global, so a module that uses a
 * database still has to say so.
 */
@Module({
  imports: [DrizzleModule],
  providers: [
    {
      provide: TENANT_SCOPED_UNIT_OF_WORK,
      useClass: PostgresTenantScopedUnitOfWork,
    },
    { provide: PLATFORM_UNIT_OF_WORK, useClass: PostgresPlatformUnitOfWork },
  ],
  exports: [TENANT_SCOPED_UNIT_OF_WORK, PLATFORM_UNIT_OF_WORK],
})
export class PersistenceModule {}
