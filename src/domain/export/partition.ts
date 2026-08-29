import type { ExportWindow } from './window';

declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

/** A day, as `YYYY-MM-DD` in UTC. */
export type PartitionDay = Branded<string, 'PartitionDay'>;

/** The path an object is written at. */
export type ObjectKey = Branded<string, 'ObjectKey'>;

/** The two datasets that are replaced whole rather than added to. */
export type CatalogueDataset = 'products' | 'locations';

/**
 * A tenant identifier as it appears in a path.
 *
 * Checked rather than trusted. A key is a path, and a tenant carrying a slash
 * or a `..` would write into a prefix that is not its own — the one way this
 * design could cross tenants without any query being wrong.
 */
const IDENTIFIER = /^[0-9a-fA-F-]{36}$/;

/**
 * The day a movement was recorded, in UTC.
 *
 * UTC rather than local time, so a partition means the same thing on the
 * machine that wrote it and the machine that reads it. Late evening in Bogotá
 * is already tomorrow in UTC, and a partition that depends on where the process
 * ran is a partition two readers disagree about.
 */
export function partitionDay(recordedAt: Date): PartitionDay {
  return recordedAt.toISOString().slice(0, 10) as PartitionDay;
}

/** One tenant's segment of a path. Never a whole prefix on its own. */
export function tenantSegment(tenantId: string): string {
  if (!IDENTIFIER.test(tenantId)) {
    throw new Error(`a tenant identifier is not a path segment: "${tenantId}"`);
  }
  return `tenant_id=${tenantId}/`;
}

/**
 * Everything of one dataset belonging to one tenant.
 *
 * **The dataset comes before the tenant, deliberately.** A query engine points
 * a table at one prefix and reads partition values out of the path below it, so
 * `movements/` has to hold movements and nothing else, with `tenant_id` as a
 * partition of that table. Putting the tenant first would read more naturally
 * and would force either a table per tenant or a table whose location mixes
 * three datasets.
 *
 * The consequence worth stating: **a tenant has no single prefix.** Everything
 * of one tenant is three prefixes, one per dataset, and anything that means to
 * sweep a tenant has to ask for all three.
 */
export function prefixFor(
  dataset: 'movements' | CatalogueDataset,
  tenantId: string,
): string {
  return `${dataset}/${tenantSegment(tenantId)}`;
}

/**
 * Where one run's movements for one day are written.
 *
 * **Named for the window, never for the run.** The same window always produces
 * the same key, so a replayed run rewrites the same object with the same rows
 * rather than adding a second copy — which is the whole of how a failed run is
 * finished rather than duplicated. A later run carrying a different window
 * writes a second object in the same day's partition, leaving the first
 * untouched.
 *
 * `tenant_id=` and `recorded_date=` are Hive-style names because that is what a
 * query engine discovers partitions from; nothing here depends on how it does.
 */
export function movementsKey(destination: {
  tenantId: string;
  day: PartitionDay;
  window: ExportWindow;
}): ObjectKey {
  const { tenantId, day, window } = destination;

  return `${prefixFor('movements', tenantId)}recorded_date=${day}/${window.from}-${window.to}.parquet` as ObjectKey;
}

/**
 * Where a tenant's catalogue is written.
 *
 * One fixed name per dataset, because the catalogue is replaced whole every
 * run: a reader looks in one place and sees it as it is now, and a renamed
 * product has one name rather than one per run that ever happened.
 */
export function catalogueKey(
  tenantId: string,
  dataset: CatalogueDataset,
): ObjectKey {
  return `${prefixFor(dataset, tenantId)}${dataset}.parquet` as ObjectKey;
}
