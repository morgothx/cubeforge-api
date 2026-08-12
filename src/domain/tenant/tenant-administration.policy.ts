import { DomainViolation } from '../errors';

/**
 * A tenant left with no active administrator can only be repaired from outside
 * the product, which contradicts the rule that platform operators never reach
 * inside a tenant. Both the revocation path and the role-change path arrive
 * here, because they are one invariant reached from two directions.
 *
 * The count is supplied by the caller rather than read here, which keeps the
 * rule pure arithmetic and testable with no persistence.
 */
export function assertTenantRetainsAdministrator(input: {
  readonly activeAdministratorCount: number;
  readonly changeRemovesAnAdministrator: boolean;
}): void {
  if (!input.changeRemovesAnAdministrator) {
    return;
  }

  if (input.activeAdministratorCount <= 1) {
    throw new DomainViolation({ kind: 'last-administrator' });
  }
}
