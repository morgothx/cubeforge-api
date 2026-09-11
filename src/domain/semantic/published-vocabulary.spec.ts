import { DomainViolation } from '../errors';
import {
  CALENDAR,
  LONGEST_PERIOD_DAYS,
  day,
  periodFrom,
  type Day,
} from '../analytics/period';
import { describeVocabulary } from './published-vocabulary';
import { questionFrom } from './question';
import { GROUPINGS, MEASURES, READ_BY } from './vocabulary';

const aPeriod = periodFrom(day('2026-08-01'), day('2026-08-31'));

/** `days` after `from`, on the calendar the platform counts in. */
function daysAfter(from: Day, days: number): Day {
  const moment = new Date(`${from}T00:00:00.000Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return day(moment.toISOString().slice(0, 10));
}

describe('the published vocabulary', () => {
  /**
   * The body the dashboard's design adopted, field for field.
   *
   * Written out rather than derived, on purpose: it is the one test here that
   * is about the contract rather than about agreement. A change to it is a
   * change `cubeforge-web` has to revalidate against, and failing here is how
   * the person making it finds out before the dashboard does.
   */
  it('publishes the body the dashboard adopted', () => {
    expect(describeVocabulary()).toEqual({
      measures: [
        { name: 'net_quantity', cumulative: false },
        { name: 'movement_count', cumulative: false },
        { name: 'on_hand_quantity', cumulative: true },
      ],
      groupings: [
        { name: 'recorded_day', shape: 'day', column: 'recorded_day' },
        { name: 'occurred_day', shape: 'day', column: 'occurred_day' },
        { name: 'kind', shape: 'category', column: 'kind' },
        {
          name: 'product',
          shape: 'labelled',
          codeColumn: 'product_code',
          nameColumn: 'product_name',
        },
        {
          name: 'location',
          shape: 'labelled',
          codeColumn: 'location_code',
          nameColumn: 'location_name',
        },
      ],
      readBy: ['recorded', 'occurred'],
      longestPeriodDays: 366,
      calendar: 'UTC',
    });
  });

  it('lists the offered names and moments in the order they are declared', () => {
    const published = describeVocabulary();

    expect(published.measures.map(({ name }) => name)).toEqual([...MEASURES]);
    expect(published.groupings.map(({ name }) => name)).toEqual([...GROUPINGS]);
    expect(published.readBy).toEqual([...READ_BY]);
    expect(published.calendar).toBe(CALENDAR);
  });

  /**
   * The claim the route exists to make, tested as a claim: not "the
   * projection reads the tuples", which is how it is built, but "a name the
   * vocabulary publishes is a name a question accepts" — whatever it is built
   * from.
   */
  it('publishes only names a question accepts', () => {
    const published = describeVocabulary();

    for (const { name } of published.measures) {
      expect(() =>
        questionFrom({
          measures: [name],
          groupings: [],
          period: aPeriod,
          by: 'recorded',
        }),
      ).not.toThrow();
    }
    for (const { name } of published.groupings) {
      expect(() =>
        questionFrom({
          measures: [published.measures[0].name],
          groupings: [name],
          period: aPeriod,
          by: 'recorded',
        }),
      ).not.toThrow();
    }
  });

  it('leaves out every name a question refuses', () => {
    const published = describeVocabulary();
    // Built from the published names so it cannot be one of them.
    const absent = [
      ...published.measures.map(({ name }) => name),
      ...published.groupings.map(({ name }) => name),
    ].join('_');

    expect(() =>
      questionFrom({
        measures: [absent],
        groupings: [],
        period: aPeriod,
        by: 'recorded',
      }),
    ).toThrow(DomainViolation);
    expect(() =>
      questionFrom({
        measures: [published.measures[0].name],
        groupings: [absent],
        period: aPeriod,
        by: 'recorded',
      }),
    ).toThrow(DomainViolation);
  });

  it('states the longest period a question accepts, and not a day more', () => {
    const { longestPeriodDays } = describeVocabulary();
    const from = day('2026-01-01');

    // Inclusive of both ends, as a period is.
    expect(() =>
      periodFrom(from, daysAfter(from, longestPeriodDays - 1)),
    ).not.toThrow();
    expect(() => periodFrom(from, daysAfter(from, longestPeriodDays))).toThrow(
      String(LONGEST_PERIOD_DAYS),
    );
  });

  it('is the same for every caller, because it takes no tenant to differ by', () => {
    expect(describeVocabulary).toHaveLength(0);
    expect(describeVocabulary()).toEqual(describeVocabulary());
  });

  /**
   * Nothing beyond the names and what a consumer needs to use them. The row
   * bound is named by the refusal that enforces it, and a label would be a
   * second vocabulary written in prose.
   */
  it('carries no row bound and no label', () => {
    const published = describeVocabulary();

    expect(Object.keys(published).sort()).toEqual(
      [
        'calendar',
        'groupings',
        'longestPeriodDays',
        'measures',
        'readBy',
      ].sort(),
    );
    for (const measure of published.measures) {
      expect(Object.keys(measure).sort()).toEqual(['cumulative', 'name']);
    }
  });
});
