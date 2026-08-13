import type { IdentifierGenerator } from '../../application/ports/identifier-generator';
import {
  membershipId,
  personId,
  tenantId,
  type MembershipId,
  type PersonId,
  type TenantId,
} from '../../domain/identifiers';

/**
 * Predictable identifiers for tests. Each kind counts separately and carries its
 * own prefix, so an assertion that names an identifier says which kind it meant.
 */
export class SequentialIdentifierGenerator implements IdentifierGenerator {
  private readonly counts = new Map<string, number>();

  tenantId(): TenantId {
    return tenantId(this.next('tenant'));
  }

  personId(): PersonId {
    return personId(this.next('person'));
  }

  membershipId(): MembershipId {
    return membershipId(this.next('membership'));
  }

  private next(kind: string): string {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return `${kind}-${count}`;
  }
}
