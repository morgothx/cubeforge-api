import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
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
 * UUIDv4, which is what the runtime offers without a dependency. The design
 * prefers time-ordered v7 for index locality; the columns are `uuid` either
 * way, so adopting v7 later is a change here and nowhere else.
 */
@Injectable()
export class UuidIdentifierGenerator implements IdentifierGenerator {
  tenantId(): TenantId {
    return tenantId(randomUUID());
  }

  personId(): PersonId {
    return personId(randomUUID());
  }

  membershipId(): MembershipId {
    return membershipId(randomUUID());
  }

  apiKeyId(): ApiKeyId {
    return apiKeyId(randomUUID());
  }

  signInId(): SignInId {
    return signInId(randomUUID());
  }

  rowId(): string {
    return randomUUID();
  }
}
