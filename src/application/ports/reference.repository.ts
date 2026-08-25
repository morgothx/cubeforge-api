/**
 * The shape a product and a place share.
 *
 * They are the same thing twice: a tenant-owned entity keyed by a code the
 * tenant chooses, declared idempotently, never deleted, and pointed at by
 * movements. Sharing the *interface* rather than a base class is deliberate —
 * the two implementations have nothing in common but their shape, and a shared
 * parent would be inheritance standing in for a type.
 *
 * No method takes a tenant. The scope comes from the transaction, so passing
 * the wrong one is not a mistake anyone can make here.
 */
export interface ReferenceEntity<Code extends string> {
  readonly code: Code;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Whether a declaration recorded something new or replaced what was there. */
export type Declaration = 'created' | 'updated';

export interface ReferenceRepository<Code extends string, Attributes> {
  /**
   * Records the entity, or replaces its describable attributes if the code is
   * already declared in this tenant, and reports which happened.
   *
   * One call rather than a read followed by a write: the two are a race, and
   * two synchronisations declaring the same product at once would otherwise
   * both decide it was absent.
   */
  declare(code: Code, attributes: Attributes): Promise<Declaration>;

  /**
   * Which of these codes are declared in this tenant.
   *
   * Returns membership rather than rows. It is the only question asked before
   * recording a batch, and handing back records nobody reads is an invitation
   * to read them.
   */
  declared(codes: readonly Code[]): Promise<ReadonlySet<Code>>;

  list(): Promise<readonly ReferenceEntity<Code>[]>;

  /**
   * There is no `delete`, here or in either implementation. Movements already
   * recorded point at these rows, and the database grants no deletion either —
   * two absences, so restoring one by accident is not enough.
   */
}
