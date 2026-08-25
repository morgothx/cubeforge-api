import type { ExternalMovementId, LocationCode, Sku } from './identifiers';

/**
 * Three kinds, and deliberately no fourth.
 *
 * There is no `transfer`, because stock moving between two places is two
 * movements — one leaving the source, one arriving at the destination. A single
 * row naming two places would be a different table with a different sum, and
 * the absence of the kind is what keeps it out.
 */
export type MovementKind = 'receipt' | 'sale' | 'adjustment';

export interface SubmittedMovement {
  /** The source system's own document number. Unique within a tenant. */
  readonly externalId: ExternalMovementId;
  readonly sku: Sku;
  readonly location: LocationCode;
  readonly kind: MovementKind;
  readonly quantity: number;
  readonly occurredAt: Date;
}

export interface Movement extends SubmittedMovement {
  /** When the platform stored it. Only ever moves forward. */
  readonly recordedAt: Date;
}

/** Every way a movement can be wrong without asking the database anything. */
export type StandaloneRefusal =
  | 'unknown-kind'
  | 'quantity-zero'
  | 'quantity-not-whole'
  | 'quantity-out-of-range'
  | 'quantity-sign-mismatch'
  | 'occurred-in-future'
  | 'occurred-not-a-moment';

export type Judgement =
  | { readonly admissible: true }
  | { readonly admissible: false; readonly reason: StandaloneRefusal };

const KINDS: readonly string[] = ['receipt', 'sale', 'adjustment'];

/** The range of a signed 32-bit column. */
const LARGEST = 2_147_483_647;

/**
 * The sign each kind must carry.
 *
 * An arrival adds and a sale removes; an adjustment is a stocktake correcting a
 * drift that could have gone either way, so it is the one kind with no sign to
 * impose. This is the rule that catches an integration which inverted its sign
 * convention — a mistake that is otherwise invisible until a total runs
 * backwards in a chart nobody suspects.
 */
const REQUIRED_SIGN: Readonly<Record<MovementKind, 1 | -1 | 0>> = {
  receipt: 1,
  sale: -1,
  adjustment: 0,
};

const refused = (reason: StandaloneRefusal): Judgement => ({
  admissible: false,
  reason,
});

/**
 * Judges a movement against nothing but itself and the current moment.
 *
 * Kept pure and kept separate from the use case that calls it, because these
 * are the rules a batch can apply before touching the database — which is what
 * makes an entirely malformed batch of five hundred cost one round trip and no
 * writes.
 *
 * **One reason, not a list.** A caller fixing a row fixes one thing and
 * resubmits, and the report this feeds has five hundred entries in it.
 */
export function judgeMovement(
  movement: SubmittedMovement,
  now: Date,
): Judgement {
  if (!KINDS.includes(movement.kind)) {
    return refused('unknown-kind');
  }

  const { quantity } = movement;
  if (!Number.isInteger(quantity)) {
    // Covers NaN and both infinities as well as a fraction: units of measure
    // are out of scope, so a quantity is a whole number of whatever the product
    // is counted in.
    return refused('quantity-not-whole');
  }
  if (quantity === 0) {
    return refused('quantity-zero');
  }
  if (Math.abs(quantity) > LARGEST) {
    // Refused here rather than left to the column, because inside a batch this
    // has to be one row's rejection and not the whole request's failure.
    return refused('quantity-out-of-range');
  }

  const required = REQUIRED_SIGN[movement.kind];
  if (required !== 0 && Math.sign(quantity) !== required) {
    return refused('quantity-sign-mismatch');
  }

  const occurred = movement.occurredAt.getTime();
  if (Number.isNaN(occurred)) {
    return refused('occurred-not-a-moment');
  }
  if (occurred > now.getTime()) {
    // The past is ordinary — a nightly synchronisation reports yesterday. The
    // future is not something a source system can have observed.
    return refused('occurred-in-future');
  }

  return { admissible: true };
}
