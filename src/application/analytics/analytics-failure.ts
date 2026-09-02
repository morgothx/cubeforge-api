/**
 * Why a question could not be answered.
 *
 * A closed set naming classes of problem, never records. An operator acting for
 * the whole platform reads these, and each one is a different thing to do:
 * a destination that is not there is fixed, a refused credential is replaced,
 * a timeout is waited out or the question narrowed.
 *
 * Every one of these must have a producer by the time the adapter that raises
 * them is finished. The previous feature shipped a reason nothing could emit,
 * and its validation gate is what noticed.
 */
export type AnalyticsFailureReason =
  /**
   * The settings naming the catalogue, the pool and the results location are
   * absent or incomplete. Its own class rather than a kind of unreachable,
   * because the two are different work: an operator supplies a value here,
   * where "unreachable" sends them to look at a host that is answering fine.
   * The missing keys are named in the log and in nothing that leaves the
   * process.
   */
  | 'not-configured'
  | 'store-unreachable'
  | 'store-rejected'
  /**
   * The semantic layer is not answering: nothing is listening, the name does
   * not resolve, or the connection was refused or reset.
   *
   * Not a kind of `store-unreachable`, deliberately. The two send an operator
   * to different places — one to a container that is not running, the other to
   * object storage that is answering perfectly well — and a reason that sends
   * whoever is on call to the wrong place costs more than no reason at all.
   */
  | 'model-unreachable'
  /**
   * The semantic layer answered, and what it answered was an error.
   *
   * In practice this is a member the platform offers and the model no longer
   * defines, or a question the model refused to compose. Its own class rather
   * than a kind of failure, because a service that answers is a service that
   * can be asked what it objected to — in a log, never in a response, since a
   * query layer's error body regularly carries the statement it generated.
   */
  | 'model-rejected'
  | 'question-timed-out'
  | 'question-failed';

/**
 * A failure that already knows which class of problem it was.
 *
 * Classified where it happened rather than sorted out afterwards by reading an
 * error message: by then the only thing left to inspect is a string written by
 * a driver, and matching on those is how a rephrased library message silently
 * turns every failure into the wrong kind.
 *
 * The cause travels as `cause` and is kept out of the message, because an
 * engine's wording can carry the statement it ran and where the data lives.
 */
export class AnalyticsUnavailable extends Error {
  constructor(
    readonly reason: AnalyticsFailureReason,
    cause: unknown,
  ) {
    super(`the question failed: ${reason}`);
    this.name = 'AnalyticsUnavailable';
    this.cause = cause;
  }
}

/**
 * Runs one step and gives whatever it throws the reason that step's failure
 * has. An already-classified failure passes through untouched, so the innermost
 * step to know what went wrong is the one that names it.
 */
export async function askingAs<T>(
  reason: AnalyticsFailureReason,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw error instanceof AnalyticsUnavailable
      ? error
      : new AnalyticsUnavailable(reason, error);
  }
}

/**
 * The class of problem to report.
 *
 * The fallback covers one thing only: an error escaping from between the
 * classified steps, which would be a defect in the analytics rather than in
 * anything it talked to.
 */
export function reasonOf(error: unknown): AnalyticsFailureReason {
  return error instanceof AnalyticsUnavailable
    ? error.reason
    : 'question-failed';
}
