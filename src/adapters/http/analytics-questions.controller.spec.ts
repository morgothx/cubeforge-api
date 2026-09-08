import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { Request } from 'express';
import {
  ASK_MODELLED_QUESTION_ROLES,
  type ModelledQuestionQuery,
} from '../../application/semantic/ask-modelled-question.use-case';
import { LONGEST_PERIOD_DAYS } from '../../domain/analytics/period';
import { DomainViolation } from '../../domain/errors';
import { personId, tenantId } from '../../domain/identifiers';
import { PERMITTED_ROLES } from '../../domain/membership/role';
import {
  answeredFrom,
  neverExported,
  type ModelledAnswer,
} from '../../domain/semantic/modelled-answer';
import { MAX_ANSWER_ROWS } from '../../domain/semantic/question';
import { GROUPINGS, MEASURES } from '../../domain/semantic/vocabulary';
import { AnalyticsQuestionsController } from './analytics-questions.controller';
import { ModelledQuestionRequest } from './dto/analytics.dto';
import { attachActor } from './principal.middleware';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const ASKER = personId('22222222-2222-4222-8222-222222222222');

/**
 * A request with an actor already resolved, placed the way the middleware
 * places it — under its own symbol rather than under a property a test could
 * invent. A fake that set the wrong key would pass a controller that never
 * read it.
 */
function asMember(): Request {
  const request = {} as Request;
  attachActor(request, {
    kind: 'tenant-member',
    personId: ASKER,
    tenantId: ACME,
  });
  return request;
}

/** Records the question that reached the use case, and answers as told. */
function useCaseAnswering(answer: ModelledAnswer) {
  const asked: ModelledQuestionQuery[] = [];
  return {
    asked,
    useCase: {
      execute: (query: ModelledQuestionQuery) => {
        asked.push(query);
        return Promise.resolve(answer);
      },
    },
  };
}

const controllerOver = (useCase: { execute: unknown }) =>
  new AnalyticsQuestionsController(
    useCase as ConstructorParameters<typeof AnalyticsQuestionsController>[0],
  );

const aBody = (
  over: Partial<ModelledQuestionRequest> = {},
): ModelledQuestionRequest => ({
  measures: ['net_quantity'],
  from: '2026-03-01',
  to: '2026-03-31',
  ...over,
});

const refusalFrom = async (asking: Promise<unknown>) => {
  const outcome: unknown = await asking.catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(DomainViolation);
  return (outcome as DomainViolation).error;
};

describe('the shape a composed question arrives in', () => {
  const validate = (body: unknown) =>
    validateSync(plainToInstance(ModelledQuestionRequest, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts a question naming measures and two days', () => {
    expect(validate(aBody())).toEqual([]);
  });

  it('accepts a question with groupings and a moment to read by', () => {
    expect(validate(aBody({ groupings: ['kind'], by: 'occurred' }))).toEqual(
      [],
    );
  });

  /**
   * The tenant has nowhere to go, and a body that names one is refused rather
   * than quietly stripped. Refusing tells the caller they tried something the
   * platform will not do; ignoring teaches them it worked.
   */
  it('refuses a body that names a tenant', () => {
    const refusals = validate({ ...aBody(), tenantId: ACME });

    expect(refusals).not.toEqual([]);
    expect(JSON.stringify(refusals)).toContain('tenantId');
  });

  it('refuses a question naming no measure at all', () => {
    expect(validate(aBody({ measures: [] }))).not.toEqual([]);
  });

  it('refuses days that are not written as days, and a moment that is neither', () => {
    expect(validate(aBody({ from: '01-03-2026' }))).not.toEqual([]);
    expect(validate(aBody({ to: 'yesterday' }))).not.toEqual([]);
    expect(validate(aBody({ by: 'invented' as 'recorded' }))).not.toEqual([]);
  });

  it('leaves what a name means to the domain, not to the shape', () => {
    // `revenue` is not a measure this model offers. That is not a syntax
    // question, and answering it here would put the vocabulary in two places.
    expect(validate(aBody({ measures: ['revenue'] }))).toEqual([]);
  });
});

describe('composing a question at the edge', () => {
  it('hands the use case the composition the caller asked for', async () => {
    const { useCase, asked } = useCaseAnswering(neverExported());

    await controllerOver(useCase).ask(
      asMember(),
      aBody({ groupings: ['kind'], by: 'occurred' }),
    );

    expect(asked).toHaveLength(1);
    expect(asked[0].question.measures).toEqual(['net_quantity']);
    expect(asked[0].question.groupings).toEqual(['kind']);
    expect(asked[0].question.by).toBe('occurred');
    expect(asked[0].question.limit).toBe(MAX_ANSWER_ROWS);
  });

  it('reads by the day the platform recorded unless told otherwise', async () => {
    const { useCase, asked } = useCaseAnswering(neverExported());

    await controllerOver(useCase).ask(asMember(), aBody());

    expect(asked[0].question.by).toBe('recorded');
    expect(asked[0].question.groupings).toEqual([]);
  });

  it('refuses an unknown name before the use case runs, naming what is offered', async () => {
    const { useCase, asked } = useCaseAnswering(neverExported());

    const refusal = await refusalFrom(
      controllerOver(useCase).ask(
        asMember(),
        aBody({ measures: ['net_quantity', 'revenue'] }),
      ),
    );

    expect(refusal).toMatchObject({ kind: 'validation', field: 'measures' });
    const detail = (refusal as { detail: string }).detail;
    expect(detail).toContain('revenue');
    for (const offered of [...MEASURES, ...GROUPINGS]) {
      expect(detail).toContain(offered);
    }
    expect(asked).toHaveLength(0);
  });

  it('refuses a period longer than the platform answers, naming the limit', async () => {
    const { useCase, asked } = useCaseAnswering(neverExported());

    const refusal = await refusalFrom(
      controllerOver(useCase).ask(
        asMember(),
        aBody({ from: '2025-01-01', to: '2026-06-30' }),
      ),
    );

    expect(refusal).toMatchObject({ kind: 'validation', field: 'period' });
    expect((refusal as { detail: string }).detail).toContain(
      String(LONGEST_PERIOD_DAYS),
    );
    expect(asked).toHaveLength(0);
  });

  it('refuses a day that passes the pattern and is not on the calendar', async () => {
    const { useCase } = useCaseAnswering(neverExported());

    const refusal = await refusalFrom(
      controllerOver(useCase).ask(asMember(), aBody({ to: '2026-02-30' })),
    );

    expect(refusal).toMatchObject({ kind: 'validation', field: 'period' });
  });

  it('keeps the answer’s states apart across the edge', async () => {
    const absent = useCaseAnswering(neverExported());
    expect(
      await controllerOver(absent.useCase).ask(asMember(), aBody()),
    ).toEqual({ state: 'never-exported' });

    const answered = useCaseAnswering(
      answeredFrom('prepared', new Date('2026-03-30T00:00:00.000Z'), [
        { values: { net_quantity: '12', kind: 'receipt' } },
      ]),
    );

    expect(
      await controllerOver(answered.useCase).ask(asMember(), aBody()),
    ).toEqual({
      state: 'answered',
      completeThrough: '2026-03-30T00:00:00.000Z',
      servedFrom: 'prepared',
      rows: [{ net_quantity: '12', kind: 'receipt' }],
    });
  });

  it('permits exactly the tenant roles, and no machines', () => {
    expect([...ASK_MODELLED_QUESTION_ROLES].sort()).toEqual(
      [...PERMITTED_ROLES].sort(),
    );
  });
});
