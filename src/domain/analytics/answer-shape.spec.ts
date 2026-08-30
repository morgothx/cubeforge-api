import { decodeRows, type AnswerColumn } from './answer-shape';

const COLUMNS: readonly AnswerColumn[] = [
  { name: 'sku', kind: 'text' },
  { name: 'quantity', kind: 'whole-number' },
  { name: 'recorded_at', kind: 'moment' },
  { name: 'recorded_date', kind: 'day' },
];

const HEADER = ['sku', 'quantity', 'recorded_at', 'recorded_date'];

/**
 * Text in, declared types out.
 *
 * Every value arrives as text whichever engine sent it, and the local one
 * reports every column's type as text as well — so an adapter typing a result
 * from the engine's own metadata would be right in a deployment and wrong here,
 * which is the worst of both. The declaration is the contract.
 */
describe('reading what the engine sent', () => {
  const first = (rows: readonly (readonly (string | null)[])[]) =>
    decodeRows(COLUMNS, HEADER, rows)[0];

  it('turns text into the types the question declared', () => {
    const row = first([
      ['ACME-001', '12', '2026-08-27 02:00:00', '2026-08-27'],
    ]);

    expect(row.get('sku')).toBe('ACME-001');
    expect(row.get('quantity')).toBe(12);
    expect(row.get('recorded_at')).toEqual(
      new Date('2026-08-27T02:00:00.000Z'),
    );
    expect(row.get('recorded_date')).toBe('2026-08-27');
  });

  it('reads a moment as the moment the engine meant, not as local time', () => {
    // The engine sends UTC with no zone on it, and `new Date(...)` on such a
    // string reads it as *local* time. On a machine five hours behind UTC that
    // silently moves every moment by five hours, and on a CI box running in UTC
    // it does not — a defect that only appears where somebody actually works.
    const row = first([['ACME-001', '1', '2026-08-27 02:00:00', '2026-08-27']]);
    const moment = row.get('recorded_at');

    expect(moment).toBeInstanceOf(Date);
    expect((moment as Date).toISOString()).toBe('2026-08-27T02:00:00.000Z');
  });

  it('keeps a null a null rather than inventing a zero', () => {
    const row = first([
      ['ACME-001', null, '2026-08-27 02:00:00', '2026-08-27'],
    ]);

    // A quantity that is absent is not a quantity of nothing.
    expect(row.get('quantity')).toBeNull();
  });

  it('refuses a declared column the answer does not carry', () => {
    // Loudly, and by name. A column quietly read as absent is a chart with a
    // missing series and nothing to explain it.
    expect(() =>
      decodeRows(COLUMNS, ['sku', 'quantity', 'recorded_at'], []),
    ).toThrow('recorded_date');
  });

  it('refuses a value that will not become what it was declared to be', () => {
    expect(() =>
      first([['ACME-001', 'twelve', '2026-08-27 02:00:00', '2026-08-27']]),
    ).toThrow('quantity');
    expect(() =>
      first([['ACME-001', '12', 'not a moment', '2026-08-27']]),
    ).toThrow('recorded_at');
  });

  it('reads columns by name, so their order in the answer is not a contract', () => {
    const shuffled = ['recorded_date', 'sku', 'recorded_at', 'quantity'];
    const row = decodeRows(COLUMNS, shuffled, [
      ['2026-08-27', 'ACME-001', '2026-08-27 02:00:00', '12'],
    ])[0];

    expect(row.get('sku')).toBe('ACME-001');
    expect(row.get('quantity')).toBe(12);
  });

  it('ignores a column the answer carries and the question did not ask for', () => {
    const row = decodeRows(
      COLUMNS,
      [...HEADER, 'internal'],
      [['ACME-001', '12', '2026-08-27 02:00:00', '2026-08-27', 'whatever']],
    )[0];

    expect([...row.keys()].sort()).toEqual([
      'quantity',
      'recorded_at',
      'recorded_date',
      'sku',
    ]);
  });
});
