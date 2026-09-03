import { GROUPINGS, MEASURES, groupingsFrom, measuresFrom } from './vocabulary';

describe('what a caller may name', () => {
  it('accepts every measure and every grouping it offers', () => {
    // Driven from the published lists rather than from a copy of them, so a
    // name added to the vocabulary and not to the parser fails here rather
    // than at whatever asks for it first.
    expect(measuresFrom(MEASURES)).toEqual({ ok: true, names: MEASURES });
    expect(groupingsFrom(GROUPINGS)).toEqual({ ok: true, names: GROUPINGS });
  });

  it('names every unrecognised measure at once, not the first one', () => {
    const result = measuresFrom(['net_quantity', 'revenue', 'margin']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.unknown).toEqual([
      'revenue',
      'margin',
    ]);
  });

  it('says what it does offer, so a caller can fix the question', () => {
    // A refusal that only says "no" is a refusal a caller answers by guessing.
    // Both lists travel, because a name in the wrong half of a question is the
    // likeliest mistake there is.
    const result = groupingsFrom(['warehouse']);

    expect(result.ok === false && result.refusal).toEqual({
      unknown: ['warehouse'],
      measures: MEASURES,
      groupings: GROUPINGS,
    });
  });

  it('is exact about a name, and says so rather than guessing at one', () => {
    for (const name of ['Net_Quantity', ' net_quantity', 'netQuantity']) {
      expect(measuresFrom([name])).toEqual({
        ok: false,
        refusal: { unknown: [name], measures: MEASURES, groupings: GROUPINGS },
      });
    }
  });

  it('has nothing to refuse in a question that names none', () => {
    // Whether a question may name no measure at all is the question's rule,
    // not the vocabulary's. Here it is simply nothing to check.
    expect(measuresFrom([])).toEqual({ ok: true, names: [] });
    expect(groupingsFrom([])).toEqual({ ok: true, names: [] });
  });

  it('offers a measure for what moved, what was recorded, and what is on hand', () => {
    expect(MEASURES).toEqual([
      'net_quantity',
      'movement_count',
      'on_hand_quantity',
    ]);
    expect(GROUPINGS).toEqual([
      'recorded_day',
      'occurred_day',
      'kind',
      'product',
      'location',
    ]);
  });
});
