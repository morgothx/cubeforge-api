import {
  transactionId,
  windowFrom,
  type ExportWindow,
  type TransactionId,
} from './window';

/**
 * How far one tenant's export has been carried.
 *
 * Three states, and `started` is the one the whole design turns on: a run
 * records the window it is about to carry **before** writing anything, so a run
 * that dies leaves its window recorded rather than lost.
 */
export type ExportCursor =
  | { readonly state: 'never-carried' }
  | { readonly state: 'carried'; readonly through: TransactionId }
  | { readonly state: 'started'; readonly window: ExportWindow };

export const carried = (through: TransactionId): ExportCursor => ({
  state: 'carried',
  through,
});

export const started = (window: ExportWindow): ExportCursor => ({
  state: 'started',
  window,
});

/** What the next run should do. */
export type NextWindow =
  | { readonly decision: 'carry'; readonly window: ExportWindow }
  | { readonly decision: 'up-to-date' };

/** A tenant never carried has its whole history ahead of it. */
const FIRST = transactionId(1n);

/**
 * Decides the window the next run carries.
 *
 * The rule that matters: an abandoned window is **replayed as recorded**, never
 * recomputed against the current horizon. The objects that run was writing are
 * named for that window, so replaying it rewrites the same keys with the same
 * rows — which is how a failed run is finished. Recomputing would write the
 * same movements under different names, and a reader would count them twice.
 */
export function nextWindow(
  cursor: ExportCursor,
  horizon: TransactionId,
): NextWindow {
  if (cursor.state === 'started') {
    return { decision: 'carry', window: cursor.window };
  }

  const from = cursor.state === 'carried' ? cursor.through : FIRST;

  if (from === horizon) {
    return { decision: 'up-to-date' };
  }
  if (from > horizon) {
    // Nothing legitimate moves a horizon backwards: identifiers only increase.
    // Carrying a window backwards would rewrite history under names that
    // already exist holding something else, so this stops rather than guesses.
    throw new Error(
      `the transaction horizon went backwards: carried through ${from}, horizon ${horizon}`,
    );
  }

  return { decision: 'carry', window: windowFrom(from, horizon) };
}
