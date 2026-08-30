import { LONGEST_PERIOD_DAYS, day, periodFrom } from './period';

/**
 * What a caller may ask for, and how much of it.
 *
 * The bound is not politeness. A question with no bound reads a tenant's whole
 * history, and where this runs for real that is paid for by the byte and by
 * whoever is next in the queue.
 */
describe('the period a question covers', () => {
  it('reads a day as the export writes one', () => {
    // The same shape the exported keys partition by, so a period's ends and a
    // partition's name are comparable without a conversion nobody would think
    // to test.
    expect(day('2026-08-27')).toBe('2026-08-27');
  });

  it('refuses anything that is not a day', () => {
    for (const wrong of [
      '2026-8-27',
      '27-08-2026',
      '2026-08-27T00:00:00Z',
      '',
    ]) {
      expect(() => day(wrong)).toThrow('day');
    }
  });

  it('refuses a day that is not on the calendar', () => {
    // `2026-02-30` is the right shape and no date at all. A period ending there
    // would compare as a string and quietly cover nothing.
    expect(() => day('2026-02-30')).toThrow('day');
    expect(() => day('2026-13-01')).toThrow('day');
  });

  it('covers both of its ends, so one day is a period naming itself twice', () => {
    const period = periodFrom(day('2026-08-27'), day('2026-08-27'));

    expect(period.covers(day('2026-08-27'))).toBe(true);
    expect(period.covers(day('2026-08-26'))).toBe(false);
    expect(period.covers(day('2026-08-28'))).toBe(false);
  });

  it('refuses a period that ends before it starts', () => {
    expect(() => periodFrom(day('2026-08-27'), day('2026-08-26'))).toThrow(
      'ends before it starts',
    );
  });

  it('refuses a period longer than the platform answers, and says how long that is', () => {
    const from = day('2025-01-01');
    const tooLong = periodFrom(from, day('2025-12-31'));
    expect(tooLong.covers(day('2025-06-15'))).toBe(true);

    expect(() => periodFrom(from, day('2026-06-01'))).toThrow(
      String(LONGEST_PERIOD_DAYS),
    );
  });

  it('answers the longest period it will answer, exactly', () => {
    // The boundary itself is allowed. A limit that refused the value it names
    // would be a limit nobody could read off the error message.
    const from = day('2026-01-01');
    const last = new Date('2026-01-01T00:00:00.000Z');
    last.setUTCDate(last.getUTCDate() + LONGEST_PERIOD_DAYS - 1);

    expect(() =>
      periodFrom(from, day(last.toISOString().slice(0, 10))),
    ).not.toThrow();
  });
});
