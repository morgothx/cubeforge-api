import type { IdentifierGenerator } from '../../application/ports/identifier-generator';
import {
  apiKeyId,
  membershipId,
  personId,
  signInId,
  tenantId,
  type ApiKeyId,
  type MembershipId,
  type PersonId,
  type SignInId,
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

  apiKeyId(): ApiKeyId {
    return apiKeyId(this.next('api-key'));
  }

  signInId(): SignInId {
    return signInId(this.next('sign-in'));
  }

  rowId(): string {
    return this.next('row');
  }

  private next(kind: string): string {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return `${kind}-${count}`;
  }
}
