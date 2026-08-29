import type { TransactionId } from './window';

/**
 * Why a tenant's export did not finish.
 *
 * A closed set naming classes of problem, never records. The report is read by
 * whoever runs the export — a platform-wide operator — and a reason carrying a
 * SKU, an object key or another tenant's identifier would put one tenant's
 * contents in front of someone acting for all of them.
 */
export type ExportFailureReason =
  | 'storage-unreachable'
  | 'storage-rejected'
  | 'database-unavailable'
  | 'write-failed';

export interface CarriedCounts {
  readonly movements: number;
  readonly partitions: number;
  readonly through: TransactionId;
}

export type TenantOutcome =
  | ({ readonly status: 'carried'; readonly tenantId: string } & CarriedCounts)
  | { readonly status: 'up-to-date'; readonly tenantId: string }
  | {
      readonly status: 'failed';
      readonly tenantId: string;
      readonly reason: ExportFailureReason;
    };

export const carriedTenant = (
  tenantId: string,
  counts: CarriedCounts,
): TenantOutcome => ({ status: 'carried', tenantId, ...counts });

export const upToDateTenant = (tenantId: string): TenantOutcome => ({
  status: 'up-to-date',
  tenantId,
});

export const failedTenant = (
  tenantId: string,
  reason: ExportFailureReason,
): TenantOutcome => ({ status: 'failed', tenantId, reason });

export interface ExportReport {
  readonly outcomes: readonly TenantOutcome[];
  readonly carried: number;
  readonly upToDate: number;
  readonly failed: number;
  readonly movements: number;
  readonly partitions: number;
  /** False if any tenant failed. A run is not a success in part. */
  readonly succeeded: boolean;
}

/**
 * Turns per-tenant outcomes into what the run reports.
 *
 * One failure fails the run: an operator reading only the exit status must not
 * be told everything is fine. The tenants that worked are still reported as
 * having worked, because they did, and their cursors moved.
 */
export function reportOf(outcomes: readonly TenantOutcome[]): ExportReport {
  const named = new Set<string>();
  for (const outcome of outcomes) {
    if (named.has(outcome.tenantId)) {
      // Two answers for one tenant is a run nobody can read: carried and failed
      // at once says nothing about whether that tenant's cursor moved.
      throw new Error(`one tenant reported twice: ${outcome.tenantId}`);
    }
    named.add(outcome.tenantId);
  }

  const of = (status: TenantOutcome['status']): TenantOutcome[] =>
    outcomes.filter((outcome) => outcome.status === status);

  const carried = of('carried');

  return {
    outcomes,
    carried: carried.length,
    upToDate: of('up-to-date').length,
    failed: of('failed').length,
    movements: carried.reduce(
      (total, outcome) =>
        total + (outcome.status === 'carried' ? outcome.movements : 0),
      0,
    ),
    partitions: carried.reduce(
      (total, outcome) =>
        total + (outcome.status === 'carried' ? outcome.partitions : 0),
      0,
    ),
    succeeded: of('failed').length === 0,
  };
}
