import {
  CreateDatabaseCommand,
  CreateTableCommand,
  GlueClient,
  UpdateTableCommand,
  type TableInput,
} from '@aws-sdk/client-glue';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { AnalyticsConfig } from './analytics-config';
import { catalogueTables, type CatalogueTable } from './catalogue-definition';

const PARQUET = {
  InputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
  OutputFormat:
    'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
  SerdeInfo: {
    SerializationLibrary:
      'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
  },
} as const;

/** What the command did, so an operator can read it rather than infer it. */
export interface CatalogueReport {
  readonly database: string;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly resultsLocation: string;
}

/**
 * Puts the catalogue where the engine will look for it.
 *
 * **Safe to run twice**, because an operator will: a table that exists is
 * updated rather than refused, so this is how the catalogue is corrected after
 * the export's layout changes as well as how it is first created.
 *
 * It also creates the place the engine writes its answers. Nothing else does,
 * and a question asked before that place exists fails wearing the engine's
 * wording rather than saying what is missing.
 */
export class GlueCatalogue {
  private readonly glue: GlueClient;
  private readonly objects: S3Client;

  constructor(
    private readonly config: AnalyticsConfig,
    private readonly exportBucket: string,
  ) {
    const options = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
    };
    this.glue = new GlueClient(options);
    this.objects = new S3Client({ ...options, forcePathStyle: true });
  }

  async apply(): Promise<CatalogueReport> {
    await this.ensureResultsLocation();
    await this.ensureDatabase();

    const created: string[] = [];
    const updated: string[] = [];

    for (const table of catalogueTables(this.exportBucket)) {
      const wasCreated = await this.ensureTable(table);
      (wasCreated ? created : updated).push(table.name);
    }

    return {
      database: this.config.database,
      created,
      updated,
      resultsLocation: this.config.resultsLocation,
    };
  }

  close(): void {
    this.glue.destroy();
    this.objects.destroy();
  }

  private async ensureResultsLocation(): Promise<void> {
    const bucket = this.config.resultsLocation
      .replace('s3://', '')
      .split('/')[0];
    await tolerating('AlreadyExists', () =>
      this.objects.send(new CreateBucketCommand({ Bucket: bucket })),
    );
  }

  private async ensureDatabase(): Promise<void> {
    await tolerating('AlreadyExists', () =>
      this.glue.send(
        new CreateDatabaseCommand({
          DatabaseInput: { Name: this.config.database },
        }),
      ),
    );
  }

  /** True when the table was created, false when one already there was updated. */
  private async ensureTable(table: CatalogueTable): Promise<boolean> {
    const input = tableInput(table);
    try {
      await this.glue.send(
        new CreateTableCommand({
          DatabaseName: this.config.database,
          TableInput: input,
        }),
      );
      return true;
    } catch (error) {
      if (!isAlreadyThere(error)) {
        throw error;
      }
      await this.glue.send(
        new UpdateTableCommand({
          DatabaseName: this.config.database,
          TableInput: input,
        }),
      );
      return false;
    }
  }
}

function tableInput(table: CatalogueTable): TableInput {
  return {
    Name: table.name,
    TableType: 'EXTERNAL_TABLE',
    Parameters: { EXTERNAL: 'TRUE', ...table.properties },
    PartitionKeys: table.partitions.map((partition) => ({
      Name: partition.name,
      Type: partition.type,
    })),
    StorageDescriptor: {
      Columns: table.columns.map((column) => ({
        Name: column.name,
        Type: column.type,
      })),
      Location: table.location,
      ...PARQUET,
    },
  };
}

const isAlreadyThere = (error: unknown): boolean =>
  error instanceof Error && error.name.includes('AlreadyExists');

async function tolerating<T>(
  what: string,
  call: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && error.name.includes(what)) {
      return undefined;
    }
    throw error;
  }
}
