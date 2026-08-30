import { Module } from '@nestjs/common';
import { AthenaAnalytics } from './adapters/analytics/athena-analytics';
import { loadAnalyticsConfig } from './adapters/analytics/analytics-config';
import { DeferredAnalytics } from './adapters/analytics/deferred-analytics';
import { AnalyticsController } from './adapters/http/analytics.controller';
import { ReadExportedStockUseCase } from './application/analytics/read-exported-stock.use-case';
import { ReadMovementHistoryUseCase } from './application/analytics/read-movement-history.use-case';
import {
  TENANT_SCOPED_ANALYTICS,
  type TenantScopedAnalytics,
} from './application/ports/tenant-scoped-analytics';

type Env = Record<string, string | undefined>;

/**
 * The seam this module binds, exported so a test can build it the way the
 * module does. A test that assembled its own would pass just as happily while
 * the module read the environment a moment too early.
 */
export function analyticsSeam(env: Env): TenantScopedAnalytics {
  return new DeferredAnalytics(
    () => new AthenaAnalytics(loadAnalyticsConfig(env)),
  );
}

/**
 * The analytical surface, wired.
 *
 * **Imported by `AppModule`, unlike `ExportModule`**, and the asymmetry is the
 * decision rather than an inconsistency. The export is a command a scheduler
 * runs; this is reachable by a request, so it has to be in the graph a request
 * travels through.
 *
 * `PersistenceModule` is deliberately absent. Nothing here opens a database
 * transaction or holds a repository — requirement 3.4 in the form the module
 * system can enforce, since a provider that is not imported cannot be injected.
 * The one thing that does read PostgreSQL on this path is the access guard
 * deciding whether the caller may ask, which is authorization rather than
 * answering, and belongs to the platform rather than to this feature.
 *
 * The configuration is read at the first question. See `DeferredAnalytics` for
 * why an API must not refuse to start over a setting one route uses.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [
    {
      provide: TENANT_SCOPED_ANALYTICS,
      useFactory: () => analyticsSeam(process.env),
    },
    ReadMovementHistoryUseCase,
    /**
     * Provided though no controller injects it. Requirement 1.1 is answered by
     * the port, and step 8 is its consumer; binding it here is what makes the
     * question reachable without a second module and what keeps the two
     * questions from drifting apart in how they are wired.
     */
    ReadExportedStockUseCase,
  ],
  exports: [ReadExportedStockUseCase, ReadMovementHistoryUseCase],
})
export class AnalyticsModule {}
