import { InMemoryModel } from './in-memory-model';
import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import type { ModelQuestions } from '../../application/ports/tenant-scoped-model';
import { day, periodFrom } from '../../domain/analytics/period';
import { tenantId, type TenantId } from '../../domain/identifiers';
import { MAX_ANSWER_ROWS, questionFrom } from '../../domain/semantic/question';
import type { ModelledRow } from '../../domain/semantic/modelled-answer';

const acme = tenantId('11111111-1111-4111-8111-111111111111');
const exportedThrough = new Date('2026-03-31T00:00:00.000Z');

const march = periodFrom(day('2026-03-01'), day('2026-03-31'));
const aQuestion = questionFrom({
  measures: ['net_quantity'],
  groupings: ['recorded_day'],
  period: march,
  by: 'recorded',
});

function rowOn(recorded: string, occurred = recorded): ModelledRow {
  return {
    values: { recorded_day: recorded, occurred_day: occurred, net_quantity: 1 },
  };
}

async function askFor(
  model: InMemoryModel,
  tenant: TenantId,
  question = aQuestion,
) {
  return model.askAs(tenant, (questions: ModelQuestions) =>
    questions.ask(question),
  );
}

describe('the model double', () => {
  it('refuses a tenant identifier that is not one, as a rejection', async () => {
    const model = new InMemoryModel();

    await expect(askFor(model, 'not-a-uuid' as TenantId)).rejects.toThrow(
      'tenant identifier',
    );
  });

  it('says never-exported for a tenant nothing was carried for', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, { rows: [rowOn('2026-03-05')] });

    const other = tenantId('22222222-2222-4222-8222-222222222222');
    await expect(askFor(model, other)).resolves.toEqual({
      state: 'never-exported',
    });
  });

  it('answers with no rows rather than never-exported when the period is empty', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, { rows: [rowOn('2026-01-05')] });

    const answer = await askFor(model, acme);

    expect(answer.state).toBe('answered');
    if (answer.state !== 'answered') {
      throw new Error('unreachable');
    }
    expect(answer.rows).toEqual([]);
    expect(answer.completeThrough).toBe(exportedThrough);
  });

  it('filters by the period, and by the moment the question reads by', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, {
      rows: [
        rowOn('2026-03-05', '2026-01-05'),
        rowOn('2026-01-05', '2026-03-05'),
      ],
    });

    const byRecorded = await askFor(model, acme);
    const byOccurred = await askFor(
      model,
      acme,
      questionFrom({
        measures: ['net_quantity'],
        groupings: ['occurred_day'],
        period: march,
        by: 'occurred',
      }),
    );

    expect(rowCount(byRecorded)).toBe(1);
    expect(rowCount(byOccurred)).toBe(1);
    expect(byRecorded).not.toEqual(byOccurred);
  });

  it('keeps a row carrying no day, because absent is not outside the period', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, {
      rows: [{ values: { kind: 'receipt', net_quantity: 7 } }],
    });

    const answer = await askFor(
      model,
      acme,
      questionFrom({
        measures: ['net_quantity'],
        groupings: ['kind'],
        period: march,
        by: 'recorded',
      }),
    );

    expect(rowCount(answer)).toBe(1);
  });

  it('does not trim to the bound, so a caller above it can still refuse', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, {
      rows: Array.from({ length: MAX_ANSWER_ROWS + 1 }, () =>
        rowOn('2026-03-05'),
      ),
    });

    expect(rowCount(await askFor(model, acme))).toBe(MAX_ANSWER_ROWS + 1);
  });

  it('reports where an answer was served from, as arranged', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, {
      rows: [rowOn('2026-03-05')],
      servedFrom: 'prepared',
    });

    const answer = await askFor(model, acme);
    expect(answer.state === 'answered' && answer.servedFrom).toBe('prepared');
  });

  it('reads from the exported objects unless a test says otherwise', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, { rows: [rowOn('2026-03-05')] });

    const answer = await askFor(model, acme);
    expect(answer.state === 'answered' && answer.servedFrom).toBe(
      'exported-objects',
    );
  });

  it('fails every question with the diagnosis the real seam would give', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, { rows: [] });
    model.fails('model-unreachable');

    await expect(askFor(model, acme)).rejects.toBeInstanceOf(
      AnalyticsUnavailable,
    );
  });

  it('hands out a model with nowhere to receive a tenant', async () => {
    const model = new InMemoryModel();
    model.carried(acme, exportedThrough, { rows: [] });

    const methods = await model.askAs(acme, (questions) =>
      Promise.resolve(Object.keys(questions)),
    );

    expect(methods).toEqual(['ask']);
  });
});

function rowCount(answer: Awaited<ReturnType<typeof askFor>>): number {
  return answer.state === 'answered' ? answer.rows.length : -1;
}
