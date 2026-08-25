import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import type { TenantId } from '../../domain/identifiers';
import { locationCode, sku } from '../../domain/inventory/identifiers';
import type { Role } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import { DeclareLocationUseCase } from './declare-location.use-case';
import { DeclareProductUseCase } from './declare-product.use-case';
import { ReadStockOnHandUseCase } from './read-stock-on-hand.use-case';
import {
  RecordMovementsUseCase,
  type SubmittedRow,
} from './record-movements.use-case';

function row(overrides: Partial<SubmittedRow> = {}): SubmittedRow {
  return {
    externalId: 'ERP-1',
    sku: 'ACME-001',
    location: 'WH-1',
    kind: 'receipt',
    quantity: 5,
    occurredAt: '2025-12-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('recording a batch of movements', () => {
  let context: IdentityTestContext;
  let acme: TenantId;
  let globex: TenantId;
  let record: RecordMovementsUseCase;
  let stock: ReadStockOnHandUseCase;

  const machineIn = (
    tenant: TenantId,
    role: Role = 'editor',
  ): ActorContext => ({
    kind: 'machine',
    apiKeyId: context.identifiers.apiKeyId(),
    tenantId: tenant,
    role,
  });

  async function withCatalogue(tenant: TenantId): Promise<void> {
    await new DeclareProductUseCase(context.tenantScoped).execute({
      actor: machineIn(tenant),
      sku: sku('ACME-001'),
      name: 'A widget',
      category: null,
    });
    for (const code of ['WH-1', 'WH-2']) {
      await new DeclareLocationUseCase(context.tenantScoped).execute({
        actor: machineIn(tenant),
        code: locationCode(code),
        name: code,
      });
    }
  }

  beforeEach(async () => {
    context = createIdentityTestContext();
    acme = await context.seedTenant('Acme');
    globex = await context.seedTenant('Globex');
    record = new RecordMovementsUseCase(context.tenantScoped, context.clock);
    stock = new ReadStockOnHandUseCase(context.tenantScoped);
    await withCatalogue(acme);
  });

  const submit = (movements: readonly SubmittedRow[], tenant = acme) =>
    record.execute({ actor: machineIn(tenant), movements });

  it('records a batch that breaks nothing', async () => {
    const report = await submit([
      row({ externalId: 'ERP-1' }),
      row({ externalId: 'ERP-2' }),
    ]);

    expect(report).toEqual({
      recorded: 2,
      alreadyRecorded: 0,
      rejected: 0,
      outcomes: [
        { status: 'recorded', externalId: 'ERP-1' },
        { status: 'recorded', externalId: 'ERP-2' },
      ],
    });
  });

  it('records the rest when some rows are wrong, and says which', async () => {
    // The whole reason a batch is applied partially. Rejecting all of it
    // because three rows are bad means one mistyped SKU stops the night.
    const report = await submit([
      row({ externalId: 'ERP-1' }),
      row({ externalId: 'ERP-2', sku: 'NOT-DECLARED' }),
      row({ externalId: 'ERP-3', quantity: 0 }),
      row({ externalId: 'ERP-4' }),
    ]);

    expect(report.recorded).toBe(2);
    expect(report.rejected).toBe(2);
    expect(report.outcomes).toEqual([
      { status: 'recorded', externalId: 'ERP-1' },
      { status: 'rejected', externalId: 'ERP-2', reason: 'unknown-sku' },
      { status: 'rejected', externalId: 'ERP-3', reason: 'quantity-zero' },
      { status: 'recorded', externalId: 'ERP-4' },
    ]);
  });

  it('answers for every row it was given, in the order it was given', async () => {
    // The report is positional. A caller correlates by index, so a missing
    // entry would shift every later row's meaning by one.
    const rows = Array.from({ length: 25 }, (_, at) =>
      row({ externalId: `ERP-${at}`, quantity: at % 5 === 0 ? 0 : 5 }),
    );

    const report = await submit(rows);

    expect(report.outcomes).toHaveLength(rows.length);
    expect(report.outcomes.map((outcome) => outcome.externalId)).toEqual(
      rows.map((submitted) => submitted.externalId),
    );
  });

  describe('a resubmission', () => {
    it('records nothing further and reports every row as already recorded', async () => {
      const batch = [
        row({ externalId: 'ERP-1' }),
        row({ externalId: 'ERP-2' }),
      ];
      await submit(batch);

      const report = await submit(batch);

      expect(report).toEqual({
        recorded: 0,
        alreadyRecorded: 2,
        rejected: 0,
        outcomes: [
          { status: 'already-recorded', externalId: 'ERP-1' },
          { status: 'already-recorded', externalId: 'ERP-2' },
        ],
      });
    });

    it('records only the rows that are new', async () => {
      await submit([row({ externalId: 'ERP-1' })]);

      const report = await submit([
        row({ externalId: 'ERP-1' }),
        row({ externalId: 'ERP-2' }),
      ]);

      expect(report.outcomes).toEqual([
        { status: 'already-recorded', externalId: 'ERP-1' },
        { status: 'recorded', externalId: 'ERP-2' },
      ]);
    });

    it('leaves the stock where one submission would have left it', async () => {
      const batch = [row({ externalId: 'ERP-1', quantity: 5 })];
      await submit(batch);
      await submit(batch);
      await submit(batch);

      await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual([
        { sku: 'ACME-001', location: 'WH-1', onHand: 5 },
      ]);
    });
  });

  describe('a duplicate inside one batch', () => {
    it('records the first and refuses the second', async () => {
      const report = await submit([
        row({ externalId: 'ERP-1' }),
        row({ externalId: 'ERP-1', quantity: 9 }),
      ]);

      expect(report.outcomes).toEqual([
        { status: 'recorded', externalId: 'ERP-1' },
        {
          status: 'rejected',
          externalId: 'ERP-1',
          reason: 'duplicate-within-batch',
        },
      ]);
    });

    it('does not look like a retry', async () => {
      // A caller retrying a request is expected and told `already-recorded`. A
      // caller that put one document in a batch twice has a bug in how it
      // batches, and telling it the same thing would hide that bug forever.
      const report = await submit([
        row({ externalId: 'ERP-1' }),
        row({ externalId: 'ERP-1' }),
      ]);

      expect(report.alreadyRecorded).toBe(0);
      expect(report.rejected).toBe(1);
    });
  });

  describe('what it refuses without asking the database', () => {
    it('refuses a malformed code, naming no record', async () => {
      const report = await submit([row({ sku: 'ACME 001' })]);

      expect(report.outcomes).toEqual([
        {
          status: 'rejected',
          externalId: 'ERP-1',
          reason: 'malformed-identifier',
        },
      ]);
    });

    it('has no identifier to report when the identifier is what was wrong', async () => {
      const report = await submit([row({ externalId: '' })]);

      expect(report.outcomes).toEqual([
        {
          status: 'rejected',
          externalId: null,
          reason: 'malformed-identifier',
        },
      ]);
    });

    it('refuses a movement that has not happened yet, against the clock', async () => {
      const report = await submit([
        row({ occurredAt: '2026-06-01T00:00:00.000Z' }),
      ]);

      expect(report.outcomes[0]).toMatchObject({
        reason: 'occurred-in-future',
      });
    });

    it('writes nothing at all when every row is bad', async () => {
      const report = await submit([
        row({ externalId: 'ERP-1', quantity: 0 }),
        row({ externalId: 'ERP-2', kind: 'transfer' }),
      ]);

      expect(report.recorded).toBe(0);
      await expect(stock.execute({ actor: machineIn(acme) })).resolves.toEqual(
        [],
      );
    });
  });

  describe('references', () => {
    it('refuses a place the tenant has not declared', async () => {
      const report = await submit([row({ location: 'WH-404' })]);

      expect(report.outcomes[0]).toMatchObject({ reason: 'unknown-location' });
    });

    it('answers the same for another tenant SKU as for one that exists nowhere', async () => {
      // Refusal indistinguishable from absence. Distinguishing them would let a
      // caller confirm that a SKU exists somewhere on the platform.
      await withCatalogue(globex);
      await submit(
        [
          row({
            externalId: 'ERP-THEIRS',
            sku: 'GLOBEX-ONLY',
          }),
        ],
        globex,
      );

      const theirs = await submit([
        row({ externalId: 'ERP-A', sku: 'GLOBEX-ONLY' }),
      ]);
      const nowhere = await submit([
        row({ externalId: 'ERP-B', sku: 'NOWHERE-AT-ALL' }),
      ]);

      // Compared to each other rather than to an expected literal, so the two
      // answers cannot drift apart later without this failing.
      const shapeOf = (outcome: (typeof theirs)['outcomes'][number]) => ({
        ...outcome,
        externalId: null,
      });
      expect(shapeOf(theirs.outcomes[0])).toEqual(shapeOf(nowhere.outcomes[0]));
      expect(theirs.outcomes[0]).toMatchObject({ reason: 'unknown-sku' });
    });
  });

  it('refuses a caller who acts in no tenant', async () => {
    await expect(
      record.execute({ actor: context.operator, movements: [row()] }),
    ).rejects.toMatchObject({ error: { kind: 'not-found' } });
  });
});
