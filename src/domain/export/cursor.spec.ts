import { nextWindow, carried, started, type ExportCursor } from './cursor';
import { transactionId, windowFrom } from './window';

const horizon = transactionId(500n);

/**
 * How far a tenant has been carried, and what the next run should do about it.
 *
 * Three states, and the third is the one the design exists for. A run that
 * wrote objects and then died leaves its window recorded rather than lost, so
 * the next run **finishes that window** instead of computing a new one. Same
 * window, same rows, same object keys — and writing the same key with the same
 * rows is how a failed run is finished rather than duplicated.
 */
describe('an export cursor', () => {
  it('carries everything there is, the first time', () => {
    const fresh: ExportCursor = { state: 'never-carried' };

    const next = nextWindow(fresh, horizon);

    // From 1, not from zero and not from "whatever the oldest row is": a tenant
    // never carried has its whole history ahead of it.
    expect(next).toMatchObject({ decision: 'carry' });
    expect(next.decision === 'carry' && next.window.from).toBe(1n);
    expect(next.decision === 'carry' && next.window.to).toBe(500n);
  });

  it('carries what has arrived since it last finished', () => {
    const next = nextWindow(carried(transactionId(200n)), horizon);

    expect(next.decision === 'carry' && next.window.from).toBe(200n);
    expect(next.decision === 'carry' && next.window.to).toBe(500n);
  });

  it('has nothing to do when the horizon has not moved', () => {
    const next = nextWindow(carried(horizon), horizon);

    // Not an empty window. A tenant with nothing new writes no object at all,
    // and the caller has to be told that rather than handed a range to write.
    expect(next).toEqual({ decision: 'up-to-date' });
  });

  it('finishes the window a dead run left, rather than a new one', () => {
    const abandoned = started(
      windowFrom(transactionId(200n), transactionId(300n)),
    );

    const next = nextWindow(abandoned, horizon);

    // 200 to 300, **not** 200 to 500. The objects that run was writing are
    // named for that window; recomputing against the horizon would write the
    // same rows under different names, which is the duplicate this design is
    // built to avoid.
    expect(next.decision === 'carry' && next.window.from).toBe(200n);
    expect(next.decision === 'carry' && next.window.to).toBe(300n);
  });

  it('finishes an abandoned window even when the horizon moved backwards of it', () => {
    // Defensive, and cheap: a horizon below a recorded window means somebody
    // restored a database or the cursor is from another world. Replaying the
    // recorded window is still the only safe answer, because objects for it
    // may already exist.
    const abandoned = started(
      windowFrom(transactionId(600n), transactionId(700n)),
    );

    const next = nextWindow(abandoned, horizon);

    expect(next.decision === 'carry' && next.window.to).toBe(700n);
  });

  it('refuses a horizon that has gone backwards after a finished run', () => {
    // Nothing legitimate does this. Carrying a window backwards would re-export
    // history under names that already exist with different contents.
    expect(() => nextWindow(carried(transactionId(600n)), horizon)).toThrow();
  });
});
