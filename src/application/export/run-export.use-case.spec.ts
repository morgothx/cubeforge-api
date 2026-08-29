import { InMemoryExportSink } from '../../adapters/storage/in-memory-export-sink';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { catalogueKey, prefixFor } from '../../domain/export/partition';
import type { TenantId } from '../../domain/identifiers';
import { locationCode, sku } from '../../domain/inventory/identifiers';
import type { ActorContext } from '../actor-context';
import { DeclareLocationUseCase } from '../inventory/declare-location.use-case';
import { DeclareProductUseCase } from '../inventory/declare-product.use-case';
import { RecordMovementsUseCase } from '../inventory/record-movements.use-case';
import { ExportTenantUseCase } from './export-tenant.use-case';
import { RunExportUseCase } from './run-export.use-case';

const RUN = 'run-0123456789';

describe('running an export over every tenant', () => {
  let context: IdentityTestContext;
  let sink: InMemoryExportSink;
  let runExport: RunExportUseCase;
  let tenants: TenantId[];
  let sequence = 0;

  const machineIn = (tenant: TenantId): ActorContext => ({
    kind: 'machine',
    apiKeyId: context.identifiers.apiKeyId(),
    tenantId: tenant,
    role: 'editor',
  });

  /** A tenant with a catalogue and one movement of its own. */
  async function seedWorkingTenant(name: string): Promise<TenantId> {
    const tenant = await context.seedTenant(name);
    await new DeclareProductUseCase(context.tenantScoped).execute({
      actor: machineIn(tenant),
      sku: sku('ACME-001'),
      name: 'A widget',
      category: null,
    });
    await new DeclareLocationUseCase(context.tenantScoped).execute({
      actor: machineIn(tenant),
      code: locationCode('WH-1'),
      name: 'The warehouse',
    });
    const report = await new RecordMovementsUseCase(
      context.tenantScoped,
      context.clock,
    ).execute({
      actor: machineIn(tenant),
      movements: [
        {
          externalId: `ERP-${++sequence}`,
          sku: 'ACME-001',
          location: 'WH-1',
          kind: 'receipt',
          quantity: 5,
          occurredAt: '2025-12-10T08:00:00.000Z',
        },
      ],
    });
    expect(report.recorded).toBe(1);
    return tenant;
  }

  const cursorOf = (tenant: TenantId) =>
    context.tenantScoped.runInTenant(tenant, ({ exportCursors }) =>
      exportCursors.read('movements'),
    );

  const deactivate = (tenant: TenantId) =>
    context.platform.runAsOperator(({ tenants: repository }) =>
      repository.updateStatus(tenant, 'inactive'),
    );

  beforeEach(async () => {
    context = createIdentityTestContext();
    sink = new InMemoryExportSink();
    runExport = new RunExportUseCase(
      context.platform,
      sink,
      new ExportTenantUseCase(context.tenantScoped, sink),
    );
    tenants = [];
    for (const name of ['Acme', 'Globex', 'Initech', 'Umbrella']) {
      tenants.push(await seedWorkingTenant(name));
    }
  });

  it('carries every tenant past the one that fails, and says which failed', async () => {
    const [, failing] = tenants;
    sink.failOn(catalogueKey(failing, 'products'));

    const run = await runExport.execute({ correlationId: RUN });

    expect(run.report.carried).toBe(3);
    expect(run.report.failed).toBe(1);
    // A run is not a success in part: an operator reading only the status must
    // not be told everything is fine.
    expect(run.report.succeeded).toBe(false);
    expect(run.report.outcomes).toContainEqual({
      status: 'failed',
      tenantId: failing,
      reason: 'write-failed',
    });
    for (const tenant of tenants.filter((id) => id !== failing)) {
      expect(run.report.outcomes).toContainEqual(
        expect.objectContaining({ status: 'carried', tenantId: tenant }),
      );
      await expect(cursorOf(tenant)).resolves.toMatchObject({
        state: 'carried',
      });
    }
  });

  it('leaves the failed tenant where it was, with its window still to replay', async () => {
    const [, failing] = tenants;
    sink.failOn(catalogueKey(failing, 'products'));

    await runExport.execute({ correlationId: RUN });

    // Started, never carried: the point reached did not advance, and what the
    // failed run was attempting is exactly what the next one will replay.
    await expect(cursorOf(failing)).resolves.toMatchObject({
      state: 'started',
    });
  });

  it('exports nothing for an inactive tenant', async () => {
    const [, retired] = tenants;
    await deactivate(retired);

    const run = await runExport.execute({ correlationId: RUN });

    expect(run.report.outcomes).toHaveLength(3);
    expect(
      run.report.outcomes.map((outcome) => outcome.tenantId),
    ).not.toContain(retired);
    // Nothing written under its prefixes either: an inactive tenant keeps what
    // it already had, and gains nothing.
    const under = (tenant: TenantId) =>
      sink
        .keys()
        .filter((key) => key.startsWith(prefixFor('products', tenant)));
    expect(under(retired)).toEqual([]);
    // And that emptiness means something: every tenant that *was* exported is
    // found by the same question, so a filter that matched nothing at all would
    // not pass this quietly.
    for (const tenant of tenants.filter((id) => id !== retired)) {
      expect(under(tenant)).toHaveLength(1);
    }
  });

  it('stops before touching any tenant when the destination is unreachable', async () => {
    sink.unreachable();

    await expect(runExport.execute({ correlationId: RUN })).rejects.toThrow();

    expect(sink.keys()).toEqual([]);
    for (const tenant of tenants) {
      await expect(cursorOf(tenant)).resolves.toEqual({
        state: 'never-carried',
      });
    }
  });

  it('carries one correlation identifier through what it reports', async () => {
    const run = await runExport.execute({ correlationId: RUN });

    expect(run.correlationId).toBe(RUN);
  });

  it('says nothing about any other tenant when one fails', async () => {
    const [, failing] = tenants;
    sink.failOn(catalogueKey(failing, 'products'));

    const run = await runExport.execute({ correlationId: RUN });

    const failure = run.report.outcomes.find(
      (outcome) => outcome.status === 'failed',
    );
    // A reason names a class of problem and nothing else: no key, no record,
    // and no tenant but the one it belongs to.
    expect(Object.keys(failure ?? {}).sort()).toEqual([
      'reason',
      'status',
      'tenantId',
    ]);
    const said = JSON.stringify(failure);
    for (const other of tenants.filter((id) => id !== failing)) {
      expect(said).not.toContain(other);
    }
  });
});
