import { InMemoryModel } from '../../adapters/semantic/in-memory-model';
import { day, periodFrom } from '../../domain/analytics/period';
import { DomainViolation } from '../../domain/errors';
import {
  apiKeyId,
  personId,
  tenantId,
  type TenantId,
} from '../../domain/identifiers';
import { PERMITTED_ROLES } from '../../domain/membership/role';
import type { ModelledRow } from '../../domain/semantic/modelled-answer';
import { MAX_ANSWER_ROWS, questionFrom } from '../../domain/semantic/question';
import type { ActorContext } from '../actor-context';
import {
  ASK_MODELLED_QUESTION_ROLES,
  AskModelledQuestionUseCase,
} from './ask-modelled-question.use-case';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const GLOBEX = tenantId('22222222-2222-4222-8222-222222222222');
const ASKER = personId('33333333-3333-4333-8333-333333333333');

const CARRIED_THROUGH = new Date('2026-08-29T03:00:00.000Z');
const march = periodFrom(day('2026-03-01'), day('2026-03-31'));

const memberOf = (tenant: TenantId): ActorContext => ({
  kind: 'tenant-member',
  personId: ASKER,
  tenantId: tenant,
});

const aQuestion = questionFrom({
  measures: ['net_quantity'],
  groupings: ['recorded_day'],
  period: march,
  by: 'recorded',
});

const rowOn = (recorded: string): ModelledRow => ({
  values: { recorded_day: recorded, net_quantity: 3 },
});

function useCaseOver(model: InMemoryModel): AskModelledQuestionUseCase {
  return new AskModelledQuestionUseCase(model);
}

function withRows(rows: readonly ModelledRow[]): InMemoryModel {
  const model = new InMemoryModel();
  model.carried(ACME, CARRIED_THROUGH, { rows });
  return model;
}

describe('asking one modelled question', () => {
  it('answers from the tenant the platform resolved, not one in the question', async () => {
    const answer = await useCaseOver(withRows([rowOn('2026-03-05')])).execute({
      actor: memberOf(ACME),
      question: aQuestion,
    });

    expect(answer.state).toBe('answered');
    if (answer.state !== 'answered') {
      throw new Error('unreachable');
    }
    expect(answer.rows).toHaveLength(1);
    expect(answer.completeThrough).toBe(CARRIED_THROUGH);
  });

  it('answers a tenant with nothing carried as never exported', async () => {
    const answer = await useCaseOver(withRows([rowOn('2026-03-05')])).execute({
      actor: memberOf(GLOBEX),
      question: aQuestion,
    });

    expect(answer).toEqual({ state: 'never-exported' });
  });

  it('answers a period with no records with no rows, rather than refusing', async () => {
    const answer = await useCaseOver(withRows([rowOn('2026-01-05')])).execute({
      actor: memberOf(ACME),
      question: aQuestion,
    });

    expect(answer.state === 'answered' && answer.rows).toEqual([]);
  });

  it('refuses a machine caller as it refuses an absent record', async () => {
    const refused = useCaseOver(withRows([])).execute({
      actor: {
        kind: 'machine',
        apiKeyId: apiKeyId('44444444-4444-4444-8444-444444444444'),
        tenantId: ACME,
        role: 'admin',
      },
      question: aQuestion,
    });

    await expect(refused).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  it('refuses a person acting inside no tenant the same way', async () => {
    const refused = useCaseOver(withRows([])).execute({
      actor: { kind: 'person', personId: ASKER },
      question: aQuestion,
    });

    await expect(refused).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  it('permits exactly the tenant roles, and no others', () => {
    expect([...ASK_MODELLED_QUESTION_ROLES].sort()).toEqual(
      [...PERMITTED_ROLES].sort(),
    );
  });

  it('refuses an answer over the bound, naming the bound', async () => {
    const overBound = Array.from({ length: MAX_ANSWER_ROWS + 1 }, () =>
      rowOn('2026-03-05'),
    );

    const refused = useCaseOver(withRows(overBound)).execute({
      actor: memberOf(ACME),
      question: aQuestion,
    });

    await expect(refused).rejects.toBeInstanceOf(DomainViolation);
    await expect(refused).rejects.toThrow(String(MAX_ANSWER_ROWS));
  });

  it('answers a question sitting exactly on the bound', async () => {
    const atBound = Array.from({ length: MAX_ANSWER_ROWS }, () =>
      rowOn('2026-03-05'),
    );

    const answer = await useCaseOver(withRows(atBound)).execute({
      actor: memberOf(ACME),
      question: aQuestion,
    });

    expect(answer.state === 'answered' && answer.rows).toHaveLength(
      MAX_ANSWER_ROWS,
    );
  });

  it('refuses the whole question rather than any part of the answer', async () => {
    const overBound = Array.from({ length: MAX_ANSWER_ROWS + 1 }, () =>
      rowOn('2026-03-05'),
    );

    const refusal = await useCaseOver(withRows(overBound))
      .execute({ actor: memberOf(ACME), question: aQuestion })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(DomainViolation);
    expect((refusal as DomainViolation).error).toMatchObject({
      kind: 'validation',
      field: 'question',
    });
  });
});
