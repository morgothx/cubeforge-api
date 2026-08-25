import type { StandaloneRefusal } from './movement';

/**
 * Every reason one submitted movement can be refused, from every stage.
 *
 * A closed union, so a caller can act on a reason programmatically instead of
 * matching prose, and so adding a stage cannot quietly widen what a client has
 * to handle without the compiler saying so.
 *
 * Deliberately absent: anything naming a record. `unknown-sku` is the same
 * answer whether the SKU belongs to another tenant or to nobody, which is what
 * keeps the rejection channel from becoming a way to enumerate the platform.
 */
export type RejectionReason =
  | StandaloneRefusal
  /** A code the database has no room for — blank, too long, or ill-formed. */
  | 'malformed-identifier'
  | 'unknown-sku'
  | 'unknown-location'
  /**
   * The same source-system identifier twice in one submission.
   *
   * Not a replay. A caller retrying a request is expected and answered as
   * `already-recorded`; a caller who put one document in a batch twice has a
   * bug in how it batches, and the two must not look alike.
   */
  | 'duplicate-within-batch';
