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
 * Predictable identifiers for tests, in the shape the database actually stores:
 * a UUID.
 *
 * They used to read `tenant-1`, which no `uuid` column would have accepted —
 * the double was looser than the thing it stood for, and the export found it
 * out. A tenant identifier becomes a path segment there, and the check that
 * keeps one tenant from writing outside its own prefix rejects anything that is
 * not a UUID; every export test failed on a fixture production could not have
 * produced.
 *
 * Legibility is kept where it pays: the first group names the kind and the last
 * counts, so an assertion that names an identifier still says which kind it
 * meant and which one.
 */
export class SequentialIdentifierGenerator implements IdentifierGenerator {
  private readonly counts = new Map<string, number>();

  /** The first group of each kind's identifiers. Arbitrary, but stable. */
  private static readonly KINDS: Readonly<Record<string, number>> = {
    tenant: 1,
    person: 2,
    membership: 3,
    'api-key': 4,
    'sign-in': 5,
    row: 6,
  };

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

    const family = SequentialIdentifierGenerator.KINDS[kind];
    if (family === undefined) {
      throw new Error(`no identifier family is registered for "${kind}"`);
    }

    return [
      family.toString(16).padStart(8, '0'),
      '0000',
      // Version 4 and the variant bits, so the value is a well-formed UUID and
      // not merely a string of the right length.
      '4000',
      '8000',
      count.toString(16).padStart(12, '0'),
    ].join('-');
  }
}
