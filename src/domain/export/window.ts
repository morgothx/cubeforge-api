declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

/**
 * A PostgreSQL 64-bit transaction identifier.
 *
 * A `bigint` rather than a number: 64 bits do not fit a JavaScript number, and
 * an identifier that silently loses precision would put movements on the wrong
 * side of a window without any error to notice.
 */
export type TransactionId = Branded<bigint, 'TransactionId'>;

/** PostgreSQL numbers transactions from 1; anything lower came from elsewhere. */
export function transactionId(value: bigint): TransactionId {
  if (value <= 0n) {
    throw new Error(`a transaction identifier is positive, got ${value}`);
  }
  return value as TransactionId;
}

/**
 * The range of movements one run carries.
 *
 * **Half-open**: `from` has already been carried, `to` has not. Two consecutive
 * runs meet exactly at a boundary, so no movement belongs to both windows and
 * none falls between them. A closed window would carry its last movement twice,
 * and a reader would count it twice.
 */
export interface ExportWindow {
  readonly from: TransactionId;
  readonly to: TransactionId;
  covers(identifier: TransactionId): boolean;
}

/**
 * An empty window is not a run with nothing to do — it is a question asked
 * wrongly. "Nothing to carry" is the *absence* of a window, and keeping the two
 * apart is what stops a run writing an object for no rows.
 */
export function windowFrom(
  from: TransactionId,
  to: TransactionId,
): ExportWindow {
  if (to <= from) {
    throw new Error(
      `an export window ends after it starts, got ${from} to ${to}`,
    );
  }

  return {
    from,
    to,
    covers: (identifier) => identifier >= from && identifier < to,
  };
}
