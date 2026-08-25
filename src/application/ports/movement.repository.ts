import type {
  ExternalMovementId,
  LocationCode,
  Sku,
} from '../../domain/inventory/identifiers';
import type { SubmittedMovement } from '../../domain/inventory/movement';

/** What is on hand at one place, for one product. */
export interface StockLevel {
  readonly sku: Sku;
  readonly location: LocationCode;
  /**
   * The sum of every movement recorded for this pairing. May be negative: the
   * platform records what a source system reports, and deciding what is
   * possible in that system's warehouse is not its job.
   */
  readonly onHand: number;
}

/**
 * The append-only movement stream of the tenant in context.
 *
 * There is no `update` and no `delete`, and the database grants neither — a
 * mistake is offset by a further movement, so the error stays visible beside
 * its correction. That is also what lets a later incremental export trust that
 * a row it has already written will not change underneath it.
 */
export interface MovementRepository {
  /**
   * Records every movement given, skipping any whose `externalId` is already
   * recorded in this tenant, and returns the identifiers actually recorded.
   *
   * **The skip belongs to the database, not to the caller.** Uniqueness is a
   * constraint and this method observes its outcome; reading first and
   * inserting second is a race that two concurrent retries of one batch will
   * eventually lose, producing exactly the duplicate the contract exists to
   * prevent. An implementation that checks before inserting satisfies the
   * signature and breaks the guarantee.
   *
   * Identifiers absent from the returned set were already present. That is a
   * successful replay, not a failure, and the caller reports it as such.
   */
  record(
    movements: readonly SubmittedMovement[],
  ): Promise<ReadonlySet<ExternalMovementId>>;

  /** Sums the recorded movements, per product and place. */
  stockOnHand(): Promise<readonly StockLevel[]>;
}
