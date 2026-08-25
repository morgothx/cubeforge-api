declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

/** A product code, as the tenant's own systems already spell it. */
export type Sku = Branded<string, 'Sku'>;
/** A place code, likewise. */
export type LocationCode = Branded<string, 'LocationCode'>;
/** The source system's own document number for a movement. */
export type ExternalMovementId = Branded<string, 'ExternalMovementId'>;

/** Why a code could not be accepted. */
export type Malformation = 'blank' | 'too-long' | 'unsupported-characters';

export type Parsed<T> =
  | { readonly malformed: false; readonly value: T }
  | { readonly malformed: true; readonly because: Malformation };

/**
 * Long enough for every real coding scheme and short enough that a code is
 * still a code. Nothing in the schema depends on it; it exists so a caller
 * cannot use the SKU column as a note field.
 */
const LONGEST = 64;

/**
 * Uppercase and lowercase letters, digits, and the three separators coding
 * schemes actually use.
 *
 * Deliberately narrow, and deliberately **not** trimmed or case-folded. A code
 * arrives from a system this platform does not control, and normalizing it
 * would mean ` ACME-001` and `ACME-001` are one product on the path that
 * normalizes and two on the path that forgot. Refusing is the only answer that
 * cannot be inconsistent. It is also why places are a declared resource rather
 * than free text: `WH 1`, `WH1` and `wh-1` are three warehouses to anything
 * that groups by them, and that error is invisible until a total is wrong.
 */
const SUPPORTED = /^[A-Za-z0-9._-]+$/;

function parse<T extends string>(value: string): Parsed<T> {
  if (value.trim().length === 0) {
    return { malformed: true, because: 'blank' };
  }
  if (value.length > LONGEST) {
    return { malformed: true, because: 'too-long' };
  }
  if (!SUPPORTED.test(value)) {
    return { malformed: true, because: 'unsupported-characters' };
  }
  return { malformed: false, value: value as T };
}

/**
 * The non-throwing form, for the batch path.
 *
 * A malformed code inside a batch of five hundred is one row's problem, not the
 * request's, so it has to be a value the caller can put in a report rather than
 * an exception that ends the whole submission.
 */
export const parseSku = (value: string): Parsed<Sku> => parse<Sku>(value);
export const parseLocationCode = (value: string): Parsed<LocationCode> =>
  parse<LocationCode>(value);
export const parseExternalMovementId = (
  value: string,
): Parsed<ExternalMovementId> => parse<ExternalMovementId>(value);

function orThrow<T extends string>(parsed: Parsed<T>, label: string): T {
  if (parsed.malformed) {
    throw new Error(`${label} is ${parsed.because.replace(/-/g, ' ')}`);
  }
  return parsed.value;
}

/**
 * The throwing forms, for paths where a caller has no per-row answer to give —
 * declaring one product, reading one code back out of the database.
 */
export const sku = (value: string): Sku => orThrow(parseSku(value), 'sku');
export const locationCode = (value: string): LocationCode =>
  orThrow(parseLocationCode(value), 'location code');
export const externalMovementId = (value: string): ExternalMovementId =>
  orThrow(parseExternalMovementId(value), 'external movement identifier');
