import {
  CATALOGUE_COLUMNS,
  MOVEMENT_COLUMNS,
  WATERMARK_COLUMNS,
  type ColumnarType,
  type ExportedColumn,
} from '../../domain/export/exported-row';

export interface CatalogueColumn {
  readonly name: string;
  readonly type: string;
}

export interface CatalogueTable {
  readonly name: string;
  /** The prefix the export writes this dataset under. */
  readonly location: string;
  readonly columns: readonly CatalogueColumn[];
  readonly partitions: readonly CatalogueColumn[];
  readonly properties: Readonly<Record<string, string>>;
}

/** The published type, as the engine's catalogue spells it. */
const AS_ENGINE_TYPE: Readonly<Record<ColumnarType, string>> = {
  STRING: 'string',
  INT32: 'int',
  INT64: 'bigint',
  TIMESTAMP: 'timestamp',
  BOOLEAN: 'boolean',
};

/** The earliest day the export could have written. Projection needs a floor. */
const FROM_DAY = '2024-01-01';

/**
 * What the engine is told about the exported layout.
 *
 * **Columns are derived from what the export publishes, never restated.** There
 * is one list of movement columns on this platform and this reads it, so a
 * column added upstream cannot drift from the one an engine was told about.
 *
 * **Partitions are projected, not registered.** The keys are perfectly regular
 * — a tenant and a date — which is exactly what projection wants, and it
 * removes the class of failure in which a day is exported and invisible because
 * nothing registered it.
 *
 * The tenant is the `injected` kind, which carries more than convenience: the
 * engine refuses a question that does not constrain an injected column. The
 * adapter binds the tenant and the catalogue makes a question without one fail
 * — the platform's two-independent-layers rule, arriving in analytics.
 *
 * **None of this is verifiable here.** The local engine infers partitions from
 * the key path and needs none of it, answering whether the arrangement is right
 * or wrong. What a test can check is that the right values are sent.
 */
export function catalogueTables(bucket: string): readonly CatalogueTable[] {
  return [
    partitionedByDay(bucket, 'movements', MOVEMENT_COLUMNS),
    partitionedByTenant(bucket, 'products', CATALOGUE_COLUMNS),
    partitionedByTenant(bucket, 'locations', CATALOGUE_COLUMNS),
    partitionedByTenant(bucket, 'watermarks', WATERMARK_COLUMNS),
  ];
}

function partitionedByTenant(
  bucket: string,
  name: string,
  columns: readonly ExportedColumn[],
): CatalogueTable {
  return {
    name,
    location: prefix(bucket, name),
    columns: columns.map(asCatalogueColumn),
    partitions: [{ name: 'tenant_id', type: 'string' }],
    properties: {
      ...projected(),
      'storage.location.template': `${prefix(bucket, name)}tenant_id=\${tenant_id}/`,
    },
  };
}

function partitionedByDay(
  bucket: string,
  name: string,
  columns: readonly ExportedColumn[],
): CatalogueTable {
  return {
    name,
    location: prefix(bucket, name),
    columns: columns.map(asCatalogueColumn),
    partitions: [
      { name: 'tenant_id', type: 'string' },
      { name: 'recorded_date', type: 'string' },
    ],
    properties: {
      ...projected(),
      'projection.recorded_date.type': 'date',
      'projection.recorded_date.format': 'yyyy-MM-dd',
      'projection.recorded_date.range': `${FROM_DAY},NOW`,
      'projection.recorded_date.interval': '1',
      'projection.recorded_date.interval.unit': 'DAYS',
      'storage.location.template': `${prefix(bucket, name)}tenant_id=\${tenant_id}/recorded_date=\${recorded_date}/`,
    },
  };
}

const projected = (): Record<string, string> => ({
  'projection.enabled': 'true',
  // Injected rather than enumerated: a tenant identifier is a UUID and there is
  // no range to project over. The engine therefore requires every question to
  // name one, which is the property worth having.
  'projection.tenant_id.type': 'injected',
});

const prefix = (bucket: string, dataset: string): string =>
  `s3://${bucket}/${dataset}/`;

const asCatalogueColumn = (column: ExportedColumn): CatalogueColumn => ({
  name: column.name,
  type: AS_ENGINE_TYPE[column.type],
});
