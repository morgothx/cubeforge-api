import type { ExportFailureReason } from '../../domain/export/report';

/**
 * A failure that already knows which class of problem it was.
 *
 * Classified where it happened, rather than sorted out afterwards by reading an
 * error message: by the time a run is deciding what to report, the only thing
 * left to inspect is a string written by a driver, and matching on those is how
 * a rephrased library message silently turns every failure into the wrong kind.
 *
 * The original error travels as `cause` and is deliberately kept out of the
 * message. What a run reports is read by an operator acting for the whole
 * platform, and a driver's message can carry a row, a key or another tenant's
 * identifier in it.
 */
export class ExportFailed extends Error {
  constructor(
    readonly reason: ExportFailureReason,
    cause: unknown,
  ) {
    super(`the export failed: ${reason}`);
    this.name = 'ExportFailed';
    this.cause = cause;
  }
}

/**
 * Runs one step, and gives whatever it throws the reason that step's failure
 * has. An already-classified failure passes through unchanged, so the innermost
 * step to know what went wrong is the one that names it.
 */
export async function failingAs<T>(
  reason: ExportFailureReason,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw error instanceof ExportFailed
      ? error
      : new ExportFailed(reason, error);
  }
}

/**
 * The class of problem to report for a failure.
 *
 * The fallback is a last resort and covers only one thing: an error escaping
 * from between the classified steps, which would be a defect in the export
 * itself rather than in anything it talked to. It is reported rather than
 * rethrown because one tenant's failure — including this kind — must not cost
 * every other tenant its run.
 */
export function reasonOf(error: unknown): ExportFailureReason {
  return error instanceof ExportFailed ? error.reason : 'database-unavailable';
}
