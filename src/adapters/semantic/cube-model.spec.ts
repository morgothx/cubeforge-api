import { day, periodFrom } from '../../domain/analytics/period';
import { tenantId, type TenantId } from '../../domain/identifiers';
import { MAX_ANSWER_ROWS, questionFrom } from '../../domain/semantic/question';
import type { ModelQuestions } from '../../application/ports/tenant-scoped-model';
import type { CubeLoad, CubeResult } from './cube-client';
import { CubeModel } from './cube-model';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const NOW = new Date('2026-03-31T12:00:00.000Z');
const CARRIED_THROUGH = '2026-03-30 23:59:59.000';

const march = periodFrom(day('2026-03-01'), day('2026-03-31'));

const aQuestion = (over: Partial<Parameters<typeof questionFrom>[0]> = {}) =>
  questionFrom({
    measures: ['net_quantity'],
    groupings: [],
    period: march,
    by: 'recorded',
    ...over,
  });

/** Answers each load in turn, and records every one it was given. */
function answering(...results: CubeResult[]) {
  const loads: CubeLoad[] = [];
  let next = 0;

  return {
    loads,
    transport: {
      load: (load: CubeLoad) => {
        loads.push(load);
        const result = results[Math.min(next, results.length - 1)];
        next += 1;
        return Promise.resolve(result);
      },
    },
  };
}

const watermarkOf = (moment: string): CubeResult => ({
  data: [{ 'watermarks.complete_through': moment }],
  servedFromStore: false,
});

const rowsOf = (
  data: readonly Record<string, unknown>[],
  servedFromStore = false,
): CubeResult => ({ data, servedFromStore });

function modelOver(transport: {
  load: (load: CubeLoad) => Promise<CubeResult>;
}) {
  return new CubeModel(
    transport,
    { for: (tenant: TenantId) => Promise.resolve(`context-for:${tenant}`) },
    () => NOW,
  );
}

const ask = (
  transport: { load: (load: CubeLoad) => Promise<CubeResult> },
  question = aQuestion(),
  tenant: TenantId = ACME,
) =>
  modelOver(transport).askAs(tenant, (model: ModelQuestions) =>
    model.ask(question),
  );

describe('composing one modelled question', () => {
  /**
   * The watermark is read first, and that ordering is the requirement.
   *
   * Reading it afterwards would let an export landing between the two make the
   * label later than the data it labels, which is exactly what an answer must
   * never claim. Asked first, the label can only ever be older than the rows,
   * which is safe.
   */
  it('asks how far the tenant is carried before asking the question itself', async () => {
    const { transport, loads } = answering(
      watermarkOf(CARRIED_THROUGH),
      rowsOf([{ 'movements.net_quantity': '12' }]),
    );

    await ask(transport);

    expect(loads).toHaveLength(2);
    expect(loads[0].query.measures).toEqual(['watermarks.complete_through']);
    expect(loads[1].query.measures).toEqual(['movements.net_quantity']);
  });

  it('asks both under a context minted for the tenant the platform resolved', async () => {
    const { transport, loads } = answering(
      watermarkOf(CARRIED_THROUGH),
      rowsOf([]),
    );

    await ask(transport);

    expect(loads.map((load) => load.context)).toEqual([
      `context-for:${ACME}`,
      `context-for:${ACME}`,
    ]);
  });

  it('never asks the expensive question for a tenant nothing was carried for', async () => {
    const { transport, loads } = answering(watermarkOf(''));

    const answer = await ask(transport);

    expect(answer).toEqual({ state: 'never-exported' });
    expect(loads).toHaveLength(1);
  });

  /**
   * Absent and unreadable are different facts, and only one of them means the
   * tenant has no data.
   *
   * Answering `never-exported` for a garbled watermark would report a tenant as
   * having nothing because the *label* failed, hiding rows behind it. The empty
   * value is absence; anything else that will not parse is the engine saying
   * something this cannot use, and that is refused rather than answered.
   */
  it('refuses a watermark that is present and unreadable, rather than calling it absent', async () => {
    for (const garbled of ['not a moment', '2026-13-45 99:99:99', 7]) {
      const { transport } = answering(
        rowsOf([{ 'watermarks.complete_through': garbled }]),
      );

      await expect(ask(transport)).rejects.toMatchObject({
        reason: 'model-rejected',
      });
    }
  });

  it('treats an absent watermark as absence, whether empty or null', async () => {
    for (const absent of ['', '   ', null]) {
      const { transport } = answering(
        rowsOf([{ 'watermarks.complete_through': absent }]),
      );

      await expect(ask(transport)).resolves.toEqual({
        state: 'never-exported',
      });
    }
  });

  it('states the moment the rows are complete through', async () => {
    const { transport } = answering(
      watermarkOf(CARRIED_THROUGH),
      rowsOf([{ 'movements.net_quantity': '12' }]),
    );

    const answer = await ask(transport);

    expect(answer.state === 'answered' && answer.completeThrough).toEqual(
      new Date('2026-03-30T23:59:59.000Z'),
    );
  });

  it('returns rows under the names the platform publishes, not the model’s', async () => {
    const { transport } = answering(
      watermarkOf(CARRIED_THROUGH),
      rowsOf([
        {
          'movements.net_quantity': '12',
          'movements.kind': 'receipt',
          'movements.recorded_day.day': '2026-03-05T00:00:00.000',
          'products.code': 'SKU-1',
          'products.name': 'a widget',
        },
      ]),
    );

    const answer = await ask(
      transport,
      aQuestion({ groupings: ['kind', 'recorded_day', 'product'] }),
    );

    expect(answer.state === 'answered' && answer.rows[0].values).toEqual({
      net_quantity: '12',
      kind: 'receipt',
      recorded_day: '2026-03-05T00:00:00.000',
      product_code: 'SKU-1',
      product_name: 'a widget',
    });
  });

  it('carries the period on the moment the question says to read by', async () => {
    for (const [by, dimension] of [
      ['recorded', 'movements.recorded_day'],
      ['occurred', 'movements.occurred_day'],
    ] as const) {
      const { transport, loads } = answering(
        watermarkOf(CARRIED_THROUGH),
        rowsOf([]),
      );

      await ask(transport, aQuestion({ by }));

      expect(loads[1].query.timeDimensions).toContainEqual({
        dimension,
        dateRange: ['2026-03-01', '2026-03-31'],
      });
    }
  });

  it('asks a day grouping at day granularity', async () => {
    const { transport, loads } = answering(
      watermarkOf(CARRIED_THROUGH),
      rowsOf([]),
    );

    await ask(transport, aQuestion({ groupings: ['occurred_day'] }));

    expect(loads[1].query.timeDimensions).toContainEqual({
      dimension: 'movements.occurred_day',
      granularity: 'day',
    });
  });

  it('labels a product by its code and its current name, from one grouping', async () => {
    const { transport, loads } = answering(
      watermarkOf(CARRIED_THROUGH),
      rowsOf([]),
    );

    await ask(transport, aQuestion({ groupings: ['product', 'location'] }));

    expect(loads[1].query.dimensions).toEqual([
      'products.code',
      'products.name',
      'locations.code',
      'locations.name',
    ]);
  });

  /**
   * One more than the bound, so the caller above can tell a full answer from a
   * truncated one. Asking for exactly the bound would make an over-bound answer
   * indistinguishable from one that happened to fit.
   */
  it('asks for one row more than the answer may carry', async () => {
    const { transport, loads } = answering(
      watermarkOf(CARRIED_THROUGH),
      rowsOf([]),
    );

    await ask(transport);

    expect(loads[1].query.limit).toBe(MAX_ANSWER_ROWS + 1);
  });

  it('says where the rows came from, as the layer reported it', async () => {
    for (const [reported, expected] of [
      [true, 'prepared'],
      [false, 'exported-objects'],
    ] as const) {
      const { transport } = answering(
        watermarkOf(CARRIED_THROUGH),
        rowsOf([{ 'movements.net_quantity': '1' }], reported),
      );

      const answer = await ask(transport);

      expect(answer.state === 'answered' && answer.servedFrom).toBe(expected);
    }
  });

  it('refuses a tenant identifier that is not one, before anything is asked', async () => {
    const { transport, loads } = answering(watermarkOf(CARRIED_THROUGH));

    await expect(
      ask(transport, aQuestion(), 'not-a-uuid' as TenantId),
    ).rejects.toThrow('tenant identifier');
    expect(loads).toHaveLength(0);
  });
});
