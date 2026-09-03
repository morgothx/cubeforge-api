import { DomainViolation } from '../errors';
import { LONGEST_PERIOD_DAYS, day, periodFrom } from '../analytics/period';
import { GROUPINGS, MEASURES } from './vocabulary';
import { MAX_ANSWER_ROWS, questionFrom } from './question';

const aWeek = periodFrom(day('2026-03-01'), day('2026-03-07'));

function violationFrom(build: () => unknown): DomainViolation {
  try {
    build();
  } catch (error) {
    if (error instanceof DomainViolation) {
      return error;
    }
    throw error;
  }

  throw new Error('expected the question to be refused, and it was not');
}

describe('a composed question', () => {
  it('combines any measures with any groupings, with nothing written for the combination', () => {
    const combinations = [
      { measures: ['net_quantity'], groupings: [] },
      { measures: ['movement_count'], groupings: ['kind'] },
      {
        measures: ['net_quantity', 'on_hand_quantity'],
        groupings: ['recorded_day', 'product', 'location'],
      },
      { measures: [...MEASURES], groupings: [...GROUPINGS] },
    ];

    for (const { measures, groupings } of combinations) {
      const question = questionFrom({
        measures,
        groupings,
        period: aWeek,
        by: 'recorded',
      });

      expect(question.measures).toEqual(measures);
      expect(question.groupings).toEqual(groupings);
    }
  });

  it('carries the moment to read by, and the period as it was given', () => {
    const question = questionFrom({
      measures: ['net_quantity'],
      groupings: ['occurred_day'],
      period: aWeek,
      by: 'occurred',
    });

    expect(question.by).toBe('occurred');
    expect(question.period).toBe(aWeek);
  });

  it('refuses a question that names no measure', () => {
    const violation = violationFrom(() =>
      questionFrom({
        measures: [],
        groupings: ['kind'],
        period: aWeek,
        by: 'recorded',
      }),
    );

    expect(violation.error).toMatchObject({
      kind: 'validation',
      field: 'measures',
    });
    expect(detailOf(violation)).toContain('at least one');
  });

  it('refuses every unrecognised measure at once, and says what is offered', () => {
    const violation = violationFrom(() =>
      questionFrom({
        measures: ['net_quantity', 'revenue', 'margin'],
        groupings: [],
        period: aWeek,
        by: 'recorded',
      }),
    );

    expect(violation.error).toMatchObject({
      kind: 'validation',
      field: 'measures',
    });

    const detail = detailOf(violation);
    expect(detail).toContain('revenue');
    expect(detail).toContain('margin');
    for (const offered of [...MEASURES, ...GROUPINGS]) {
      expect(detail).toContain(offered);
    }
  });

  it('refuses an unrecognised grouping against the grouping field', () => {
    const violation = violationFrom(() =>
      questionFrom({
        measures: ['net_quantity'],
        groupings: ['warehouse'],
        period: aWeek,
        by: 'recorded',
      }),
    );

    expect(violation.error).toMatchObject({
      kind: 'validation',
      field: 'groupings',
    });
    expect(detailOf(violation)).toContain('warehouse');
  });

  it('refuses both lists in one answer when both are wrong', () => {
    const violation = violationFrom(() =>
      questionFrom({
        measures: ['revenue'],
        groupings: ['warehouse'],
        period: aWeek,
        by: 'recorded',
      }),
    );

    expect(violation.error).toMatchObject({
      kind: 'validation',
      field: 'measures and groupings',
    });
    expect(detailOf(violation)).toContain('revenue');
    expect(detailOf(violation)).toContain('warehouse');
  });

  it('bounds the rows one answer may carry, and the caller does not choose it', () => {
    const question = questionFrom({
      measures: ['net_quantity'],
      groupings: [],
      period: aWeek,
      by: 'recorded',
    });

    expect(question.limit).toBe(MAX_ANSWER_ROWS);
    expect(MAX_ANSWER_ROWS).toBe(5000);
  });

  it('takes the platform period rules rather than restating them', () => {
    const tooLong = () => periodFrom(day('2025-01-01'), day('2026-06-30'));

    expect(tooLong).toThrow(String(LONGEST_PERIOD_DAYS));

    const longest = periodFrom(day('2026-01-01'), day('2026-12-31'));
    expect(() =>
      questionFrom({
        measures: ['net_quantity'],
        groupings: [],
        period: longest,
        by: 'recorded',
      }),
    ).not.toThrow();
  });

  it('has nowhere to put a tenant, so one named in the input is not carried', () => {
    const question = questionFrom({
      measures: ['net_quantity'],
      groupings: [],
      period: aWeek,
      by: 'recorded',
      tenantId: 'another-tenant',
    } as Parameters<typeof questionFrom>[0]);

    expect(Object.keys(question)).toEqual([
      'measures',
      'groupings',
      'period',
      'by',
      'limit',
    ]);
    expect(JSON.stringify(question)).not.toContain('another-tenant');
  });
});

function detailOf(violation: DomainViolation): string {
  return violation.error.kind === 'validation'
    ? violation.error.detail
    : violation.message;
}
