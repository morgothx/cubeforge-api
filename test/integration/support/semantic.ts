import type { ModelledAnswer } from '../../../src/domain/semantic/modelled-answer';

/**
 * How long to let a prepared answer catch up with an export.
 *
 * The rollup rebuilds on its own schedule and nobody asks it to, which is the
 * property requirement 6.4 wants — and the cost of that property is that a
 * question asked immediately after an export can be served from the rebuild
 * before it. Waiting is how a suite tests the rebuild rather than the race.
 */
const LONGEST_REBUILD_MS = 90_000;
const BETWEEN_LOOKS_MS = 3_000;

/**
 * Asks until the answer reflects what was just exported, then returns it.
 *
 * **Not a retry that hides flakiness.** The condition is the thing under test:
 * that the model catches up with an export without anyone asking it to. A suite
 * that asked once and asserted would be testing how fast a background worker
 * happens to be, which is a property of the afternoon rather than of the design.
 *
 * When the deadline passes it throws with what it last saw, so a real failure
 * reads as "the rollup never caught up" rather than as a timeout with nothing
 * in it.
 */
export async function untilItReflects(
  what: string,
  asking: () => Promise<ModelledAnswer>,
  settled: (answer: ModelledAnswer) => boolean,
): Promise<ModelledAnswer> {
  const deadline = Date.now() + LONGEST_REBUILD_MS;
  let latest: ModelledAnswer = await asking();

  while (!settled(latest)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `the model never reflected ${what} within ${LONGEST_REBUILD_MS}ms; ` +
          `the last answer was ${JSON.stringify(latest)}`,
      );
    }

    await new Promise((resume) => setTimeout(resume, BETWEEN_LOOKS_MS));
    latest = await asking();
  }

  return latest;
}

/** The rows of an answer that must have been answered at all. */
export function rowsOf(answer: ModelledAnswer) {
  if (answer.state !== 'answered') {
    throw new Error(`expected an answer, got ${answer.state}`);
  }
  return answer;
}
