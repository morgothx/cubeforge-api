import {
  GROUPINGS,
  GROUPING_SHAPES,
  MEASURES,
  MEASURE_TRAITS,
  type GroupingName,
  type MeasureName,
} from './vocabulary';
import { whyUnaskable } from './askable';

/**
 * The combinations this platform knows it cannot compose.
 *
 * Every name below is read from what the vocabulary already publishes rather
 * than written out, so a measure that stopped counting earlier movements, or a
 * grouping that stopped being a day, changes what these tests assert instead of
 * leaving them asserting something the platform no longer offers.
 */

const cumulative: readonly MeasureName[] = MEASURES.filter(
  (measure) => MEASURE_TRAITS[measure].cumulative,
);

const bounded: readonly MeasureName[] = MEASURES.filter(
  (measure) => !MEASURE_TRAITS[measure].cumulative,
);

const days: readonly GroupingName[] = GROUPINGS.filter(
  (grouping) => GROUPING_SHAPES[grouping].shape === 'day',
);

const notDays: readonly GroupingName[] = GROUPINGS.filter(
  (grouping) => GROUPING_SHAPES[grouping].shape !== 'day',
);

/** Every snake_case word a sentence uses, which is every name it could leak. */
function namesIn(sentence: string): string[] {
  return sentence.match(/[a-z]+(?:_[a-z]+)+/g) ?? [];
}

describe('the combinations the platform cannot compose', () => {
  it('has a measure that counts earlier movements, and two groupings by day', () => {
    // The rules below are about a shape the vocabulary has. If it ever stops
    // having it, these tests are asserting nothing and should say so loudly
    // rather than passing.
    expect(cumulative.length).toBeGreaterThan(0);
    expect(bounded.length).toBeGreaterThan(0);
    expect(days.length).toBeGreaterThan(1);
  });

  it('refuses a measure that counts earlier movements beside more than one day', () => {
    for (const measure of cumulative) {
      const why = whyUnaskable([measure], days);

      expect(why).not.toBeNull();
      expect(why).toContain(measure);
      for (const grouping of days) {
        expect(why).toContain(grouping);
      }
    }
  });

  it('says which grouping to drop', () => {
    const why = whyUnaskable(cumulative.slice(0, 1), days) ?? '';

    // The caller can act on this, and the sentence is what lets them.
    expect(why).toMatch(/one|only|drop|choose/i);
  });

  it('allows that measure beside a single day', () => {
    for (const measure of cumulative) {
      for (const grouping of days) {
        expect(whyUnaskable([measure], [grouping])).toBeNull();
        expect(whyUnaskable([measure], [grouping, ...notDays])).toBeNull();
      }
    }
  });

  it('allows that measure with no day at all', () => {
    for (const measure of cumulative) {
      expect(whyUnaskable([measure], [])).toBeNull();
      expect(whyUnaskable([measure], notDays)).toBeNull();
    }
  });

  /**
   * The rule is about the combination, not about the measure. `net_quantity`
   * with every grouping at once was measured answering against the running
   * platform on 2026-10-01; refusing it here would refuse a question the
   * platform answers.
   */
  it('allows measures that do not count earlier movements beside both days', () => {
    expect(whyUnaskable(bounded, days)).toBeNull();
    expect(whyUnaskable(bounded, [...GROUPINGS])).toBeNull();
  });

  it('refuses as soon as one measure counts earlier movements', () => {
    const mixed = [...bounded, ...cumulative];

    expect(whyUnaskable(mixed, days)).not.toBeNull();
  });

  /**
   * A sentence a caller reads may name only words the platform publishes. The
   * engine's own members — `movements.net_quantity` and the rest — are the
   * model's internal naming, and a refusal that leaked one would make the
   * dashboard's contract the model's naming.
   */
  it('names only words the vocabulary publishes', () => {
    const published: readonly string[] = [...MEASURES, ...GROUPINGS];
    const sentences = [
      whyUnaskable(cumulative.slice(0, 1), days) ?? '',
      whyUnaskable([...MEASURES], [...GROUPINGS]) ?? '',
    ];

    for (const sentence of sentences) {
      expect(sentence).not.toBe('');
      for (const name of namesIn(sentence)) {
        expect(published).toContain(name);
      }
      // A model member is `cube.member`, and its second half is a published
      // word — so the scan above alone would pass a leaked one. The shape of
      // the leak is the dot.
      expect(sentence).not.toMatch(/[a-z_]+\.[a-z_]+/);
    }
  });

  it('answers the same question the same way every time', () => {
    const once = whyUnaskable(cumulative.slice(0, 1), days);
    const again = whyUnaskable(cumulative.slice(0, 1), days);

    expect(again).toEqual(once);
  });
});
