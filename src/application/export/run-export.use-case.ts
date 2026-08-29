import { Inject, Injectable } from '@nestjs/common';
import {
  carriedTenant,
  failedTenant,
  reportOf,
  upToDateTenant,
  type ExportReport,
  type TenantOutcome,
} from '../../domain/export/report';
import type { TenantId } from '../../domain/identifiers';
import { isTenantActive } from '../../domain/tenant/tenant.entity';
import { EXPORT_SINK, type ExportSink } from '../ports/export-sink';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../ports/platform-unit-of-work';
import { ExportTenantUseCase } from './export-tenant.use-case';
import { failingAs, reasonOf } from './export-failure';

export interface RunExportCommand {
  /**
   * The label everything this run reports is filed under.
   *
   * Supplied rather than generated, exactly as an inbound request's is: the
   * entry point that starts a run owns its identity, and a use case that
   * invented one would be a use case with a source of non-determinism in it for
   * no caller's benefit.
   */
  readonly correlationId: string;
}

export interface ExportRun {
  readonly correlationId: string;
  readonly report: ExportReport;
}

@Injectable()
export class RunExportUseCase {
  constructor(
    @Inject(PLATFORM_UNIT_OF_WORK)
    private readonly platform: PlatformUnitOfWork,
    @Inject(EXPORT_SINK) private readonly sink: ExportSink,
    private readonly exportTenant: ExportTenantUseCase,
  ) {}

  async execute(command: RunExportCommand): Promise<ExportRun> {
    // Once, before the first tenant. A destination that cannot be reached or a
    // credential that is refused costs nothing this way; discovered half-way
    // through, it costs a run with some tenants carried, some not, and every
    // remaining one about to fail for the same reason.
    await failingAs('storage-unreachable', () => this.sink.reachable());

    const tenants = await failingAs('database-unavailable', () =>
      this.platform.runAsOperator(({ tenants: repository }) =>
        repository.list(),
      ),
    );

    const outcomes: TenantOutcome[] = [];
    for (const tenant of tenants) {
      // An inactive tenant keeps what it has already been given and gains
      // nothing further, so it is not an outcome at all rather than an outcome
      // saying nothing happened.
      if (!isTenantActive(tenant)) {
        continue;
      }
      // One at a time, deliberately. Each tenant is its own transaction and its
      // own failure, and running them together would multiply the load an
      // export puts on the database it is supposed to stay out of the way of.
      outcomes.push(await this.carry(tenant.id));
    }

    return { correlationId: command.correlationId, report: reportOf(outcomes) };
  }

  /**
   * One tenant, and its failure caught here.
   *
   * This `catch` is the whole of requirement 6.1: without it, one tenant with
   * odd data or an unwritable object costs every tenant after it its nightly
   * export. What it must not do is turn a failure into a success — the outcome
   * it records is what makes the run report failure overall.
   */
  private async carry(tenantId: TenantId): Promise<TenantOutcome> {
    try {
      const carried = await this.exportTenant.execute({ tenantId });
      if (carried.status === 'up-to-date') {
        return upToDateTenant(tenantId);
      }

      const { movements, partitions, through } = carried;
      return carriedTenant(tenantId, { movements, partitions, through });
    } catch (error) {
      return failedTenant(tenantId, reasonOf(error));
    }
  }
}
