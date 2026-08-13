import { DomainViolation, type DomainError } from '../../../domain/errors';

const UNIQUE_VIOLATION = '23505';

/**
 * Translates a constraint the database rejected into the error the application
 * already knows how to report.
 *
 * The check lives here rather than in a read before the write because a read
 * followed by an insert is a race: two concurrent requests can both find
 * nothing and both proceed. Letting the constraint decide is the only version
 * that is correct under concurrency, and this is what makes its verdict legible.
 *
 * Constraints are matched by name. An unrecognized violation is rethrown
 * untouched — guessing at a cause we have not accounted for would turn a real
 * defect into a plausible-looking business rule.
 */
export function translateConstraintViolation(
  error: unknown,
  known: Readonly<Record<string, DomainError>>,
): never {
  for (const candidate of causeChain(error)) {
    if (candidate.code !== UNIQUE_VIOLATION) {
      continue;
    }
    const violated = candidate.constraint;
    if (typeof violated === 'string' && violated in known) {
      throw new DomainViolation(known[violated]);
    }
  }
  throw error;
}

interface DriverError {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

/**
 * Drizzle wraps driver errors, so the SQLSTATE code and the constraint name sit
 * on `cause` rather than on the error that was thrown. Walking the chain rather
 * than reaching for `.cause` once keeps this working if another layer wraps it
 * again — and the depth limit means a self-referential chain cannot hang the
 * process while it tries.
 */
function* causeChain(error: unknown): Generator<DriverError> {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return;
    }
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}
