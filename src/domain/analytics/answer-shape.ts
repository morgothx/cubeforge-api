import { day, type Day } from './period';

/**
 * What a column of an answer is supposed to become.
 *
 * The kinds a question can ask for, and no more. A wider set would be a small
 * query language, and the point of declaring shapes is that there is exactly
 * one place to look for what a column means.
 */
export type ValueKind = 'text' | 'whole-number' | 'moment' | 'day';

export interface AnswerColumn {
  readonly name: string;
  readonly kind: ValueKind;
}

export type DecodedValue = string | number | Date | Day;
export type DecodedRow = ReadonlyMap<string, DecodedValue | null>;

/**
 * Turns what the engine sent into what the question declared.
 *
 * **The declaration is the contract, not the engine's metadata.** Every value
 * arrives as text on either engine, and the local one reports every column's
 * type as text as well — so reading types from the answer would be right in a
 * deployment and wrong in development, which is the one combination that cannot
 * be caught by running the tests.
 *
 * Columns are found by name, so their order in the answer is not a contract,
 * and a column the answer carries that the question did not declare is left
 * alone. A column the question *did* declare and the answer does not carry is
 * refused by name: read as absent it would be a chart missing a series with
 * nothing to explain it.
 */
export function decodeRows(
  columns: readonly AnswerColumn[],
  header: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): readonly DecodedRow[] {
  const at = new Map(header.map((name, index) => [name, index]));

  const missing = columns.filter((column) => !at.has(column.name));
  if (missing.length > 0) {
    throw new Error(
      `the answer carries no ${missing.map((column) => column.name).join(', ')}`,
    );
  }

  return rows.map((row) => {
    const decoded = new Map<string, DecodedValue | null>();
    for (const column of columns) {
      const raw = row[at.get(column.name)!] ?? null;
      decoded.set(column.name, raw === null ? null : decode(column, raw));
    }
    return decoded;
  });
}

function decode(column: AnswerColumn, raw: string): DecodedValue {
  switch (column.kind) {
    case 'text':
      return raw;
    case 'whole-number':
      return wholeNumber(column.name, raw);
    case 'moment':
      return moment(column.name, raw);
    case 'day':
      return dayIn(column.name, raw);
  }
}

function wholeNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} is not a whole number: "${raw}"`);
  }
  return value;
}

/**
 * A moment, read as the moment the engine meant.
 *
 * The engine sends UTC with no zone written on it, and handing such a string to
 * `new Date(...)` reads it as **local** time — which moves every moment by the
 * running machine's offset, silently, and not at all on a machine set to UTC.
 * That is a defect visible only where somebody actually works, so the zone is
 * supplied here rather than assumed.
 */
function moment(name: string, raw: string): Date {
  const asUtc = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(
    /[Zz]|[+-]\d{2}:?\d{2}$/.test(asUtc) ? asUtc : `${asUtc}Z`,
  );

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} is not a moment: "${raw}"`);
  }
  return parsed;
}

function dayIn(name: string, raw: string): Day {
  try {
    return day(raw);
  } catch {
    throw new Error(`${name} is not a day: "${raw}"`);
  }
}
