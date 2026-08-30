import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { AthenaAnalytics } from '../../src/adapters/analytics/athena-analytics';
import { ParquetExportSink } from '../../src/adapters/storage/parquet-export-sink';
import { readParquet } from '../../src/adapters/storage/parquet-runtime';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import type {
  AnalyticalAnswer,
  MovementsOnDayEntry,
  StockOnHandEntry,
} from '../../src/domain/analytics/answer';
import { day, periodFrom } from '../../src/domain/analytics/period';
import {
  catalogueKey,
  prefixFor,
  type ObjectKey,
} from '../../src/domain/export/partition';
import { tenantId, type TenantId } from '../../src/domain/identifiers';
import { ExportModule } from '../../src/export.module';
import { useAnalyticalStore } from './support/analytics';
import { asPersonInTenant, seed } from './support/database';
import { seedTenant, useIntegrationDatabase } from './support/fixtures';
import { exportDestination } from './support/object-storage';

const analytics = loadAnalyticsConfig(process.env);
const storage = exportDestination();

const AUGUST = periodFrom(day('2026-08-01'), day('2026-08-31'));

// Two tenants seeded, two exports run, and several polled questions asked.
// Jest's five-second default does not cover that, and the two analytics suites
// before this one learned it the hard way.
jest.setTimeout(60_000);

/**
 * Two tenants made deliberately indistinguishable except by their tenant.
 *
 * The same product code, the same location code, movements recorded on the same
 * days and of the same kinds. Nothing but `tenant_id` tells one tenant's rows
 * from the other's, so a lost tenant predicate cannot hide behind a difference
 * in the data: it shows up as the other tenant's number, or as the other
 * tenant's name on this tenant's product.
 *
 * **Every expectation is derived from the objects the export wrote**, read back
 * out of the bucket with the other Parquet library. A list written into this
 * file would agree with the engine only until somebody changed both, and would
 * stop being evidence the moment it did.
 */
describe('what one tenant can reach of another, analytically', () => {
  useIntegrationDatabase();
  useAnalyticalStore();

  const client = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    credentials: storage.credentials,
    forcePathStyle: true,
  });
  const reader = new ParquetExportSink(storage);

  let exports: INestApplicationContext;
  let subject: AthenaAnalytics;
  let acme: TenantId;
  let globex: TenantId;
  let people: readonly string[];

  beforeAll(async () => {
    exports = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    subject = new AthenaAnalytics(analytics);

    // Exported in this order, and asked about in both: a statement reading the
    // newest objects rather than its own would pass one direction and fail the
    // other, and only asking both directions can tell.
    acme = await lookAlikeTenant('Acme', [
      { kind: 'receipt', quantity: 10, recorded: '2026-08-27' },
      { kind: 'sale', quantity: -4, recorded: '2026-08-27' },
      { kind: 'receipt', quantity: 6, recorded: '2026-08-28' },
    ]);
    globex = await lookAlikeTenant('Globex', [
      { kind: 'receipt', quantity: 500, recorded: '2026-08-27' },
      { kind: 'sale', quantity: -111, recorded: '2026-08-28' },
    ]);
    // Sequentially. Everything else in this suite is, and a `Promise.all` here
    // would be the one place two connections overlap for no gain at all.
    people = [await memberOf(acme), await memberOf(globex)];
  });

  afterAll(async () => {
    subject.close();
    await reader.close();
    client.destroy();
    await exports.close();
  });

  /**
   * A tenant holding the shared code under its own name.
   *
   * The names differ and nothing else does, which is what makes the catalogue
   * side of the join observable: a label crossing tenants is a leak no quantity
   * check would ever notice.
   */
  async function lookAlikeTenant(
    label: string,
    movements: readonly { kind: string; quantity: number; recorded: string }[],
  ): Promise<TenantId> {
    // A generated name, not `label`. Tenant names are unique platform-wide and
    // this suite seeds in `beforeAll`, which runs *before* the per-test
    // cleanup — so a tenant called "Acme" left behind by whichever suite ran
    // last collides here. The label is what the answers are checked against and
    // needs to be recognisable; the name only needs to be free.
    const { id } = await seedTenant({ name: `${label}-${randomUUID()}` });
    const tenant = tenantId(id);

    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'SHARED-001', $2, null)`,
        [tenant, `a widget belonging to ${label}`],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', $2)`,
        [tenant, `a warehouse belonging to ${label}`],
      );
    });

    let ordinal = 0;
    for (const movement of movements) {
      ordinal += 1;
      await asPersonInTenant(tenant, (database) =>
        database.query(
          `INSERT INTO stock_movements
             (id, tenant_id, external_id, sku, location_code, kind, quantity,
              occurred_at, recorded_at)
           VALUES ($1, $2, $3, 'SHARED-001', 'WH-1', $4, $5, $6, $7)`,
          [
            randomUUID(),
            tenant,
            `ERP-${ordinal}`,
            movement.kind,
            movement.quantity,
            new Date('2026-08-01T09:00:00.000Z'),
            new Date(`${movement.recorded}T02:00:00.000Z`),
          ],
        ),
      );
    }

    await exports
      .get(RunExportUseCase)
      .execute({ correlationId: randomUUID(), onlyTenant: tenant });

    return tenant;
  }

  /** A person in the tenant, so "no person appears" has somebody to not name. */
  async function memberOf(tenant: TenantId): Promise<string> {
    const person = randomUUID();
    const email = `member-${person.slice(0, 8)}@example.com`;
    await seed(async (database) => {
      await database.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
        person,
        email,
      ]);
      await database.query(
        `INSERT INTO memberships (id, tenant_id, person_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, 'admin', 'active')`,
        [tenant, person],
      );
    });
    return `${person} ${email}`;
  }

  /** Every object the export wrote under one of a tenant's prefixes. */
  async function objectsUnder(prefix: string): Promise<readonly ObjectKey[]> {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix }),
    );
    return (listed.Contents ?? [])
      .flatMap((object) =>
        object.Key === undefined ? [] : [object.Key as ObjectKey],
      )
      .sort();
  }

  /**
   * What the export wrote for this tenant, aggregated the way the statement
   * says it should be: by the day in the key and the kind in the row.
   */
  async function movementsAsExported(
    tenant: TenantId,
  ): Promise<readonly MovementsOnDayEntry[]> {
    const totals = new Map<string, number>();

    for (const key of await objectsUnder(prefixFor('movements', tenant))) {
      const recorded = /recorded_date=(\d{4}-\d{2}-\d{2})/.exec(key)?.[1];
      if (recorded === undefined) {
        throw new Error(`no recorded_date in the key the export wrote: ${key}`);
      }
      for (const row of await readParquet(await reader.read(key))) {
        const at = `${recorded} ${String(row.kind)}`;
        totals.set(at, (totals.get(at) ?? 0) + Number(row.quantity));
      }
    }

    return [...totals.entries()]
      .map(([at, quantity]) => {
        const [recorded, kind] = at.split(' ');
        return { day: day(recorded), kind, quantity };
      })
      .sort(
        (left, right) =>
          left.day.localeCompare(right.day) ||
          left.kind.localeCompare(right.kind),
      );
  }

  /** What is on hand for this tenant, and the name its own catalogue gives it. */
  async function stockAsExported(
    tenant: TenantId,
  ): Promise<readonly StockOnHandEntry[]> {
    const names = new Map<string, string>();
    for (const row of await readParquet(
      await reader.read(catalogueKey(tenant, 'products')),
    )) {
      names.set(String(row.code), String(row.name));
    }

    const held = new Map<string, number>();
    for (const key of await objectsUnder(prefixFor('movements', tenant))) {
      for (const row of await readParquet(await reader.read(key))) {
        const sku = String(row.sku);
        held.set(sku, (held.get(sku) ?? 0) + Number(row.quantity));
      }
    }

    return [...held.entries()]
      .map(([sku, onHand]) => {
        const name = names.get(sku);
        if (name === undefined) {
          throw new Error(`the export wrote no catalogue entry for ${sku}`);
        }
        return { sku, name, onHand };
      })
      .sort((left, right) => left.sku.localeCompare(right.sku));
  }

  const quantitiesOf = (
    answer: AnalyticalAnswer<MovementsOnDayEntry>,
  ): readonly number[] =>
    answer.state === 'answered'
      ? answer.entries.map((entry) => entry.quantity)
      : [];

  it('tells each tenant exactly what the export wrote for that tenant', async () => {
    for (const tenant of [acme, globex]) {
      const answer = await subject.askAs(tenant, (q) =>
        q.movementsByDay(AUGUST),
      );

      expect(answer.state).toBe('answered');
      expect(answer.state === 'answered' && answer.entries).toEqual(
        await movementsAsExported(tenant),
      );
    }
  });

  it('gives neither tenant a number belonging to the other', async () => {
    const forAcme = await subject.askAs(acme, (q) => q.movementsByDay(AUGUST));
    const forGlobex = await subject.askAs(globex, (q) =>
      q.movementsByDay(AUGUST),
    );

    // The two tenants share every other column, so a quantity is the only thing
    // a crossed row could be recognised by — and the quantities were chosen not
    // to collide, including once summed.
    expect(quantitiesOf(forAcme)).not.toEqual([]);
    expect(quantitiesOf(forGlobex)).not.toEqual([]);
    for (const theirs of quantitiesOf(forGlobex)) {
      expect(quantitiesOf(forAcme)).not.toContain(theirs);
    }
    for (const theirs of quantitiesOf(forAcme)) {
      expect(quantitiesOf(forGlobex)).not.toContain(theirs);
    }
  });

  it('labels a shared product code with each tenant its own name', async () => {
    for (const tenant of [acme, globex]) {
      const answer = await subject.askAs(tenant, (q) => q.stockOnHand());

      // The join has a second place to lose the tenant, and this is it: the
      // code is shared, so a catalogue read left unconstrained would hand this
      // tenant the other's label with the right number beside it.
      expect(answer.state === 'answered' && answer.entries).toEqual(
        await stockAsExported(tenant),
      );
    }
  });

  it('names no tenant at all, anywhere in an answer', async () => {
    const answer = await subject.askAs(acme, (q) => q.movementsByDay(AUGUST));
    const stock = await subject.askAs(acme, (q) => q.stockOnHand());

    const said = JSON.stringify([answer, stock]);
    expect(said).not.toContain(globex);
    expect(said).not.toContain('belonging to Globex');
    // Not even its own. A tenant identifier in an answer would be a value the
    // caller never supplied and has no use for.
    expect(said).not.toContain(acme);
  });

  it('identifies nobody in any answer', async () => {
    const answers = await Promise.all([
      subject.askAs(acme, (q) => q.movementsByDay(AUGUST)),
      subject.askAs(globex, (q) => q.movementsByDay(AUGUST)),
    ]);
    const stock = await Promise.all([
      subject.askAs(acme, (q) => q.stockOnHand()),
      subject.askAs(globex, (q) => q.stockOnHand()),
    ]);

    const said = JSON.stringify([...answers, ...stock]);
    for (const person of people) {
      for (const part of person.split(' ')) {
        expect(said).not.toContain(part);
      }
    }

    // Not merely that no person happens to appear, but that there is nowhere
    // for one to: the entries carry these fields and no others. A column added
    // to an answer fails here rather than being noticed by whoever reads a
    // chart six months later.
    for (const answer of answers) {
      if (answer.state !== 'answered') {
        throw new Error('every tenant here has been exported');
      }
      for (const entry of answer.entries) {
        expect(Object.keys(entry).sort()).toEqual(['day', 'kind', 'quantity']);
      }
    }
    for (const answer of stock) {
      if (answer.state !== 'answered') {
        throw new Error('every tenant here has been exported');
      }
      for (const entry of answer.entries) {
        expect(Object.keys(entry).sort()).toEqual(['name', 'onHand', 'sku']);
      }
    }
  });
});
