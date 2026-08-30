declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

/**
 * A day, as `YYYY-MM-DD` in UTC.
 *
 * The same shape the export partitions by, deliberately: a period's ends and a
 * partition's name are then comparable as they are, with no conversion between
 * them for anybody to get wrong in one direction only.
 */
export type Day = Branded<string, 'Day'>;

const SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The longest span answerable in one question.
 *
 * A year and a day, so a question comparing this year against last fits in one
 * request. Nothing measured it; it is a first value, and the first real
 * dashboard is what should move it.
 */
export const LONGEST_PERIOD_DAYS = 366;

export function day(value: string): Day {
  if (!SHAPE.test(value)) {
    throw new Error(`a day is written YYYY-MM-DD, got "${value}"`);
  }

  // The shape is not the calendar. `2026-02-30` passes the pattern and is no
  // date at all, and a period ending there would compare as a string and
  // quietly cover nothing.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || !value.startsWith(isoDay(parsed))) {
    throw new Error(`a day must be on the calendar, got "${value}"`);
  }

  return value as Day;
}

/** The day a moment falls on, in UTC. */
export function dayOf(moment: Date): Day {
  return isoDay(moment) as Day;
}

/**
 * The range of days one question covers.
 *
 * **Inclusive of both ends**, unlike the export's half-open window over
 * transaction identifiers. The two are answering different questions: the
 * window decides which movements belong to a run and must meet its neighbour
 * exactly, while this is a person naming the days they want to see. Somebody
 * asking for a single day names it twice and means it.
 */
export interface Period {
  readonly from: Day;
  readonly to: Day;
  covers(candidate: Day): boolean;
}

/**
 * The only way to make a period, and it refuses two things.
 *
 * There is **no constructor for an unbounded period**, which is how a question
 * that would read a tenant's whole history is prevented rather than checked
 * for. And a span beyond what the platform answers is refused naming the limit,
 * because an operator who cannot read the limit off the refusal will find it by
 * bisection.
 */
export function periodFrom(from: Day, to: Day): Period {
  if (to < from) {
    throw new Error(`a period ends before it starts: ${from} to ${to}`);
  }

  if (daysBetween(from, to) > LONGEST_PERIOD_DAYS) {
    throw new Error(
      `a period covers at most ${LONGEST_PERIOD_DAYS} days, got ${from} to ${to}`,
    );
  }

  return {
    from,
    to,
    covers: (candidate) => candidate >= from && candidate <= to,
  };
}

/** Inclusive of both ends, so one day is one day rather than none. */
function daysBetween(from: Day, to: Day): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return (end - start) / 86_400_000 + 1;
}

function isoDay(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}
