import { Module } from '@nestjs/common';
import { loadObjectStorageConfig } from './adapters/storage/object-storage-config';
import { ParquetExportSink } from './adapters/storage/parquet-export-sink';
import { ExportTenantUseCase } from './application/export/export-tenant.use-case';
import { RunExportUseCase } from './application/export/run-export.use-case';
import { EXPORT_SINK } from './application/ports/export-sink';
import { PersistenceModule } from './persistence.module';

/**
 * The export, wired.
 *
 * **Not imported by `AppModule`, and that is the decision rather than an
 * oversight.** The requirements settled it before any of this was written: the
 * schedule belongs to the deployment feature, and a cron inside the API process
 * was rejected because it cannot be exercised end to end and ties the export to
 * a single instance. So what a scheduler will call is the command, not a route
 * — and an API that imported this would refuse to start whenever the export's
 * destination was unconfigured, for a capability it never uses. The design's
 * file plan said to import it; corrected here, in the direction the decision it
 * came from already pointed.
 *
 * The two repositories the export reads through are not bound here. They arrive
 * through `TenantScopedUnitOfWork`, which is what makes the export inherit
 * row-level security rather than restate it.
 */
@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: EXPORT_SINK,
      // Read at startup, so a missing setting is a message before a database
      // connection is opened rather than a failure with objects half written.
      useFactory: () =>
        new ParquetExportSink(loadObjectStorageConfig(process.env)),
    },
    ExportTenantUseCase,
    RunExportUseCase,
  ],
  exports: [RunExportUseCase],
})
export class ExportModule {}
