import {
  GROUPINGS,
  GROUPING_SHAPES,
  MEASURES,
  MEASURE_TRAITS,
  READ_BY,
  groupingsFrom,
  measuresFrom,
  rowColumnsOf,
} from './vocabulary';

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

describe('what the vocabulary declares about each name', () => {
  it('declares the moments a question may be read by, once', () => {
    expect(READ_BY).toEqual(['recorded', 'occurred']);
  });

  it('declares, for every measure and no other name, whether it counts from before the period', () => {
    // Keyed by the vocabulary's own names. The type already refuses a measure
    // without a trait; this pins which one is cumulative, for a reader and for
    // the day somebody flips it by accident.
    expect(Object.keys(MEASURE_TRAITS)).toEqual([...MEASURES]);
    expect(MEASURE_TRAITS).toEqual({
      net_quantity: { cumulative: false },
      movement_count: { cumulative: false },
      on_hand_quantity: { cumulative: true },
    });
  });

  it('declares, for every grouping and no other name, its shape and the columns it fills', () => {
    // The column names are the ones answers already carry. A value changed
    // here is a change to every answer, which is not this declaration's to
    // make.
    expect(Object.keys(GROUPING_SHAPES)).toEqual([...GROUPINGS]);
    expect(GROUPING_SHAPES).toEqual({
      recorded_day: { shape: 'day', column: 'recorded_day' },
      occurred_day: { shape: 'day', column: 'occurred_day' },
      kind: { shape: 'category', column: 'kind' },
      product: {
        shape: 'labelled',
        codeColumn: 'product_code',
        nameColumn: 'product_name',
      },
      location: {
        shape: 'labelled',
        codeColumn: 'location_code',
        nameColumn: 'location_name',
      },
    });
  });

  it('fills one column for a day or a category, and two for a labelled entity, code first', () => {
    expect(rowColumnsOf(GROUPING_SHAPES.recorded_day)).toEqual([
      'recorded_day',
    ]);
    expect(rowColumnsOf(GROUPING_SHAPES.kind)).toEqual(['kind']);
    expect(rowColumnsOf(GROUPING_SHAPES.product)).toEqual([
      'product_code',
      'product_name',
    ]);
  });
});
