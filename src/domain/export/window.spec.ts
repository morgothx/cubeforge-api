import { transactionId, windowFrom, type ExportWindow } from './window';

/**
 * The window a run carries.
 *
 * Half-open on purpose: `from` has already been carried and `to` has not. Two
 * consecutive runs therefore meet exactly at a boundary — no movement is in
 * both windows, and none falls between them. A closed window would carry its
 * last movement twice, and the second carry is what a reader would count twice.
 */
describe('an export window', () => {
  it('is half-open, so consecutive runs meet without overlapping', () => {
    const first = windowFrom(transactionId(100n), transactionId(200n));
    const second = windowFrom(transactionId(200n), transactionId(300n));

    expect(first.to).toBe(second.from);
    expect(first.covers(transactionId(199n))).toBe(true);
    // The boundary belongs to the next window and to no other.
    expect(first.covers(transactionId(200n))).toBe(false);
    expect(second.covers(transactionId(200n))).toBe(true);
  });

  it('excludes what has already been carried', () => {
    const window = windowFrom(transactionId(100n), transactionId(200n));

    expect(window.covers(transactionId(99n))).toBe(false);
    expect(window.covers(transactionId(100n))).toBe(true);
  });

  it('refuses to be empty or backwards', () => {
    // An empty window is not a run with nothing to do; it is a question asked
    // wrongly. "Nothing to carry" is the absence of a window, and keeping the
    // two apart is what stops a caller writing an object for no rows.
    expect(() =>
      windowFrom(transactionId(200n), transactionId(200n)),
    ).toThrow();
    expect(() =>
      windowFrom(transactionId(300n), transactionId(200n)),
    ).toThrow();
  });

  it('reads back as the pair it was given', () => {
    const window: ExportWindow = windowFrom(
      transactionId(1n),
      transactionId(2n),
    );

    expect(window.from).toBe(1n);
    expect(window.to).toBe(2n);
  });

  it('refuses an identifier that is not one', () => {
    // PostgreSQL numbers transactions from 1. A zero or a negative is a value
    // that came from somewhere other than the database.
    expect(() => transactionId(0n)).toThrow();
    expect(() => transactionId(-1n)).toThrow();
  });
});
