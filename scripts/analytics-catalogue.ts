import { loadAnalyticsConfig } from '../src/adapters/analytics/analytics-config';
import { GlueCatalogue } from '../src/adapters/analytics/glue-catalogue';
import { loadObjectStorageConfig } from '../src/adapters/storage/object-storage-config';

/**
 * `pnpm ops:analytics-catalogue` — tells the engine about the exported layout.
 *
 * Run once before the first question, and again whenever the export's layout
 * changes. Running it twice is safe.
 *
 * It reads both configurations, and needs to: the catalogue lives where the
 * analytics says, and it points at where the export writes. Neither knows the
 * other's setting, which is right — this command is the one place the two meet.
 */
async function main(): Promise<void> {
  const analytics = loadAnalyticsConfig(process.env);
  const { bucket } = loadObjectStorageConfig(process.env);

  const catalogue = new GlueCatalogue(analytics, bucket);
  try {
    const report = await catalogue.apply();

    console.log(`catalogue ${report.database}, over s3://${bucket}/`);
    for (const table of report.created) {
      console.log(`  created ${table}`);
    }
    for (const table of report.updated) {
      console.log(`  updated ${table}`);
    }
    console.log(`  answers are written to ${report.resultsLocation}`);
  } finally {
    catalogue.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    `the catalogue was not applied: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
