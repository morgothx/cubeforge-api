import type { ExportRun } from '../../application/export/run-export.use-case';
import type { ExportReport } from '../../domain/export/report';
import { tenantId, type TenantId } from '../../domain/identifiers';

export interface ExportArguments {
  /** Null runs every active tenant, which is what a scheduler will ask for. */
  readonly onlyTenant: TenantId | null;
}

const TENANT_FLAG = '--tenant';

/**
 * What the operator asked for, from `process.argv` and nothing else.
 *
 * **Nothing is ignored.** An argument this command was not taught is refused
 * rather than skipped: an operator who meant to narrow a run and mistyped the
 * flag would otherwise export every tenant on the platform and be told it went
 * well. There is no prompt and no default beyond "all of them", because the
 * same invocation has to work unattended from a scheduler.
 */
export function parseExportArguments(argv: readonly string[]): ExportArguments {
  // `pnpm ops:export -- --tenant X` hands the separator through to the script,
  // so the first thing this sees is a bare `--`. Dropping it is not leniency:
  // it is the shape the documented invocation actually arrives in, and refusing
  // it would make the command unusable through the script that names it.
  const args = argv[0] === '--' ? argv.slice(1) : argv;

  if (args.length === 0) {
    return { onlyTenant: null };
  }

  const [flag, value, ...rest] = args;
  if (flag !== TENANT_FLAG) {
    throw new Error(
      `unknown argument "${flag}"; the only one is ${TENANT_FLAG} <tenant-id>`,
    );
  }
  if (value === undefined) {
    throw new Error(`${TENANT_FLAG} needs a tenant identifier after it`);
  }
  if (rest.length > 0) {
    throw new Error(`unexpected argument "${rest[0]}"`);
  }

  return { onlyTenant: tenantId(value) };
}

/**
 * One line per tenant, and one for the run.
 *
 * Every line begins with the run's correlation identifier, following the
 * convention the HTTP layer already uses: what makes an identifier a
 * correlation identifier is that everything one run said can be found together.
 */
export function describeRun(run: ExportRun): string[] {
  const { correlationId, report } = run;
  const lines = report.outcomes.map((outcome) => {
    const said = `${correlationId} tenant ${outcome.tenantId}:`;
    switch (outcome.status) {
      case 'carried':
        return `${said} carried ${outcome.movements} movements into ${outcome.partitions} partitions, through ${outcome.through}`;
      case 'up-to-date':
        return `${said} up to date`;
      case 'failed':
        // The class of problem, and nothing else. This line is read by someone
        // acting for the whole platform, so it may not carry a record, a key
        // or another tenant.
        return `${said} failed, ${outcome.reason}`;
    }
  });

  return [
    ...lines,
    `${correlationId} finished: ${report.carried} carried, ${report.upToDate} up to date, ${report.failed} failed`,
  ];
}

/**
 * Success only if every tenant was carried.
 *
 * A run that lost one tenant is a run somebody has to look at, and an exit
 * status is the only part of this a scheduler will read.
 */
export function exitStatusOf(report: ExportReport): 0 | 1 {
  return report.succeeded ? 0 : 1;
}
