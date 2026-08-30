import { answered, neverExported, type AnalyticalAnswer } from './answer';
import { day } from './period';

const MOMENT = new Date('2026-08-28T02:00:00.000Z');

interface Entry {
  readonly label: string;
}

/**
 * The three things an answer can be, and why they are three.
 *
 * "Nothing happened in that period" and "this tenant has never been carried out
 * of the transactional database" are different facts, and a reader that cannot
 * tell them apart will draw an empty chart for a tenant whose data simply has
 * not arrived yet.
 */
describe('what an analytical answer is', () => {
  it('carries its entries and how far they reach', () => {
    const answer = answered(MOMENT, [{ label: 'a' }, { label: 'b' }]);

    expect(answer).toEqual({
      state: 'answered',
      completeThrough: MOMENT,
      entries: [{ label: 'a' }, { label: 'b' }],
    });
  });

  it('answers with no entries rather than refusing a quiet period', () => {
    const answer = answered(MOMENT, []);

    // Still an answer, and still says how far it reaches: "nothing moved" is
    // information, and it is only trustworthy alongside the moment it is true
    // as of.
    expect(answer.state).toBe('answered');
    expect(answer).toMatchObject({ completeThrough: MOMENT, entries: [] });
  });

  it('keeps a tenant never carried apart from one with nothing to say', () => {
    const empty: AnalyticalAnswer<Entry> = answered(MOMENT, []);
    const absent: AnalyticalAnswer<Entry> = neverExported();

    expect(absent).toEqual({ state: 'never-exported' });
    expect(absent).not.toEqual(empty);
    // And the one that has no moment cannot be read as though it had one.
    expect('completeThrough' in absent).toBe(false);
  });

  it('does not let a reader take entries without checking which answer it is', () => {
    const answer: AnalyticalAnswer<Entry> = neverExported();

    // The union is the guard. A reader reaching for entries has to narrow
    // first, which is what stops "never carried" from being drawn as zero.
    expect(answer.state === 'answered' ? answer.entries : 'narrowed').toBe(
      'narrowed',
    );
  });

  it('holds days as the period speaks of them', () => {
    // The entries are whatever the question returns, and a day among them is
    // the same day type a period is built from — so a chart's axis and the
    // question's bounds cannot drift apart.
    const answer: AnalyticalAnswer<Entry> = answered(MOMENT, [
      { label: day('2026-08-27') },
    ]);

    expect(answer.state === 'answered' && answer.entries[0]?.label).toBe(
      '2026-08-27',
    );
  });
});
