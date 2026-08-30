import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { readParquet } from '../../src/adapters/storage/parquet-runtime';
import { ExportTenantUseCase } from '../../src/application/export/export-tenant.use-case';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import type { ExportSink } from '../../src/application/ports/export-sink';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../../src/application/ports/platform-unit-of-work';
import { CLOCK, type Clock } from '../../src/application/ports/clock';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../../src/application/ports/tenant-scoped-unit-of-work';
import {
  catalogueKey,
  prefixFor,
  type ObjectKey,
} from '../../src/domain/export/partition';
import { ExportModule } from '../../src/export.module';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { asPersonInTenant, seed } from './support/database';
import {
  seedMember,
  seedTenant,
  useIntegrationDatabase,
} from './support/fixtures';
import {
  RefusingOn,
  exportDestination,
  useExportDestination,
} from './support/object-storage';

const config = exportDestination();

/**
 * The prefixes one tenant's data lives under. Never one — and now four: the
 * export publishes how far it carried each tenant, so an analytical reader can
 * say how current an answer is without asking the transactional database.
 */
const DATASETS = ['movements', 'products', 'locations', 'watermarks'] as const;

const RECORDED = new Date('2026-08-27T02:00:00.000Z');
const OCCURRED = new Date('2026-08-20T09:00:00.000Z');

const INSERT = `INSERT INTO stock_movements
    (id, tenant_id, external_id, sku, location_code, kind, quantity, occurred_at, recorded_at)
  VALUES ($1, $2, $3, 'ACME-001', 'WH-1', 'receipt', $4, $5, $6)`;

/**
 * Isolation, after the data has left the database.
 *
 * The transactional half of this platform proves tenant isolation twice over,
 * in the repository predicate and in the row-level security policy. Neither of
 * them applies to an object in a bucket. Once a row is a file, the only thing
 * keeping one tenant's history out of another's reach is the key it was written
 * under — so that is what this suite reads back and compares against what the
 * database says each tenant has.
 *
 * **A tenant has no single prefix**, which is a consequence of putting the
 * dataset before the tenant so a query engine can point one table at one
 * location. Everything of one tenant is three prefixes, and a sweep that asked
 * for one would pass while proving a third of what it claims.
 */
describe('what one tenant can find under another tenant name', () => {
  useIntegrationDatabase();
  useExportDestination();

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });
  const storage = new ParquetExportSink(config);

  let context: INestApplicationContext;

  beforeAll(async () => {
    context = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
  });

  afterAll(async () => {
    await context.close();
    await storage.close();
    client.destroy();
  });

  /**
   * Two tenants that look alike on purpose: the same SKU, the same location
   * code, and the same movement identifier. Nothing but the tenant tells their
   * rows apart, which is the arrangement in which a leak is visible.
   */
  async function twinTenant(
    label: string,
    quantity: number,
  ): Promise<TenantId> {
    const { id } = await seedTenant({ name: `Tenant ${label}` });
    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'ACME-001', $2, 'hardware')`,
        [id, `${label} widget`],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', $2)`,
        [id, `${label} warehouse`],
      );
    });
    const tenant = tenantId(id);
    // The same external identifier in both tenants: it is unique per tenant,
    // never platform-wide, so this is an ordinary state and not a contrivance.
    for (const externalId of ['ERP-1', 'ERP-2']) {
      await asPersonInTenant(tenant, (database) =>
        database.query(INSERT, [
          randomUUID(),
          tenant,
          externalId,
          quantity,
          OCCURRED,
          RECORDED,
        ]),
      );
    }
    return tenant;
  }

  function runWith(sink: ExportSink): RunExportUseCase {
    return new RunExportUseCase(
      context.get<PlatformUnitOfWork>(PLATFORM_UNIT_OF_WORK),
      sink,
      new ExportTenantUseCase(
        context.get<TenantScopedUnitOfWork>(TENANT_SCOPED_UNIT_OF_WORK),
        sink,
        context.get<Clock>(CLOCK),
      ),
    );
  }

  const runEverything = () =>
    context.get(RunExportUseCase).execute({ correlationId: randomUUID() });

  async function keysUnder(prefix: string): Promise<ObjectKey[]> {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }),
    );
    return (listed.Contents ?? []).map((object) => object.Key as ObjectKey);
  }

  /** Everything of one tenant: all three prefixes, never just the movements. */
  async function everythingOf(
    tenant: TenantId,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const dataset of DATASETS) {
      for (const key of await keysUnder(prefixFor(dataset, tenant))) {
        rows.push(...(await readParquet(await storage.read(key))));
      }
    }
    return rows;
  }

  /** What the tenant's own reader sees, through the policy, in the database. */
  const movementsInDatabase = (tenant: TenantId) =>
    asPersonInTenant(tenant, async (database) => {
      const answered = await database.query<{
        external_id: string;
        quantity: number;
      }>(
        `SELECT external_id, quantity FROM stock_movements ORDER BY external_id`,
      );
      return answered.rows;
    });

  it('gives two look-alike tenants two sets of objects, and no shared row', async () => {
    const acme = await twinTenant('Acme', 5);
    const globex = await twinTenant('Globex', 11);

    await runEverything();

    for (const [tenant, other, quantity] of [
      [acme, globex, 5],
      [globex, acme, 11],
    ] as const) {
      // Everything under this tenant's three prefixes, read back.
      const rows = await everythingOf(tenant);
      expect(rows.length).toBeGreaterThan(0);

      // Compared against what the database says this tenant has, rather than
      // against a list this test wrote — the two would agree by construction.
      const inDatabase = await movementsInDatabase(tenant);
      const exported = rows
        .filter((row) => 'external_id' in row)
        .map((row) => ({
          external_id: String(row.external_id),
          quantity: Number(row.quantity),
        }))
        .sort((left, right) =>
          left.external_id.localeCompare(right.external_id),
        );
      expect(exported).toEqual(inDatabase);

      // The quantities are what tells the two apart: a leak would show up as
      // the other tenant's number under this tenant's name.
      expect(exported.every((row) => row.quantity === quantity)).toBe(true);

      // And the catalogue too, which is why the sweep asks for three prefixes.
      // A tenant reading its own products must not meet the other's names.
      const said = JSON.stringify(rows);
      expect(said).not.toContain(other);
      expect(said).toContain(tenant === acme ? 'Acme widget' : 'Globex widget');
      expect(said).not.toContain(
        tenant === acme ? 'Globex widget' : 'Acme widget',
      );
    }
  });

  it('names the tenant in every key, and writes nothing outside the three datasets', async () => {
    const acme = await twinTenant('Acme', 5);
    const globex = await twinTenant('Globex', 11);

    await runEverything();

    for (const tenant of [acme, globex]) {
      for (const dataset of DATASETS) {
        const keys = await keysUnder(prefixFor(dataset, tenant));
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((key) => key.includes(`tenant_id=${tenant}/`))).toBe(
          true,
        );
      }
    }

    // Nothing lands outside the three datasets. This reads the whole bucket
    // rather than one tenant's corner of it, because a fourth dataset appearing
    // is exactly the kind of thing a per-tenant sweep would never see.
    const everything = await keysUnder('');
    expect(everything.length).toBeGreaterThan(0);
    expect(
      everything.filter((key) =>
        DATASETS.every((dataset) => !key.startsWith(`${dataset}/`)),
      ),
    ).toEqual([]);
  });

  it('carries nothing that identifies a person', async () => {
    const acme = await twinTenant('Acme', 5);
    const member = await seedMember({
      tenantId: acme,
      role: 'admin',
      email: 'someone@example.com',
    });

    await runEverything();

    const rows = await everythingOf(acme);
    const said = JSON.stringify(rows);

    // Requirement 1.2, read literally: no person, no membership, no credential.
    // The address and both identifiers are in the database and belong to this
    // very tenant, so finding them here would be a leak this test can see.
    expect(said).not.toContain('someone@example.com');
    expect(said).not.toContain(member.personId);
    expect(said).not.toContain(member.membershipId);

    // The columns are the published contract and nothing besides. A column
    // added by accident reaches an analytical layer that will happily chart it.
    const columns = new Set(rows.flatMap((row) => Object.keys(row)));
    expect([...columns].sort()).toEqual([
      'category',
      'code',
      'complete_through',
      'external_id',
      'kind',
      'location_code',
      'name',
      'occurred_at',
      'quantity',
      'recorded_at',
      'sku',
    ]);
  });

  it('says nothing about any other tenant when one fails', async () => {
    const acme = await twinTenant('Acme', 5);
    const globex = await twinTenant('Globex', 11);

    const run = await runWith(
      new RefusingOn(storage, catalogueKey(globex, 'products')),
    ).execute({ correlationId: randomUUID() });

    const failure = run.report.outcomes.find(
      (outcome) => outcome.status === 'failed',
    );
    expect(failure).toEqual({
      status: 'failed',
      tenantId: globex,
      reason: 'write-failed',
    });

    // A reason names a class of problem: not the other tenant, not the object
    // it could not write, not a SKU, and not a credential. The operator reading
    // this acts for the whole platform, which is exactly why one tenant's
    // contents must not arrive in a line about another's failure.
    const said = JSON.stringify(failure);
    expect(said).not.toContain(acme);
    expect(said).not.toContain('ACME-001');
    expect(said).not.toContain('products/');
    expect(said).not.toContain(config.credentials.accessKeyId);

    // And the tenant that worked is untouched by the one that did not.
    expect(run.report.outcomes).toContainEqual(
      expect.objectContaining({ status: 'carried', tenantId: acme }),
    );
  });
});
