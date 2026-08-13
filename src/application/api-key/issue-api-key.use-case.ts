import { Inject, Injectable } from '@nestjs/common';
import type { OpaqueSecret } from '../../domain/credential/secrets';
import { DomainViolation } from '../../domain/errors';
import type { ApiKeyId } from '../../domain/identifiers';
import { parseRole } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import { CLOCK, type Clock } from '../ports/clock';
import {
  IDENTIFIER_GENERATOR,
  type IdentifierGenerator,
} from '../ports/identifier-generator';
import {
  SECRET_GENERATOR,
  type SecretGenerator,
} from '../ports/secret-generator';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { authorizeInTenant, tenantOf } from '../tenant-authorization';

export interface IssueApiKeyCommand {
  readonly actor: ActorContext;
  readonly label: string;
  readonly role: string;
}

export interface IssuedApiKey {
  readonly id: ApiKeyId;
  readonly secret: OpaqueSecret;
}

/**
 * Issues a key into the administrator's own tenant, with a role from the same
 * permitted set people hold.
 *
 * The secret is returned once and stored as a digest. There is no operation
 * that returns it again, which is why the response is the only chance: a
 * contract that could hand it back later would eventually be asked to.
 */
@Injectable()
export class IssueApiKeyUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
    @Inject(SECRET_GENERATOR) private readonly secrets: SecretGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTIFIER_GENERATOR)
    private readonly identifiers: IdentifierGenerator,
  ) {}

  async execute(command: IssueApiKeyCommand): Promise<IssuedApiKey> {
    return this.unitOfWork.runInTenant(
      tenantOf(command.actor),
      async (repositories) => {
        await authorizeInTenant(repositories, command.actor, ['admin']);

        const parsed = parseRole(command.role);
        if (!parsed.ok) {
          throw new DomainViolation({
            kind: 'invalid-role',
            permitted: parsed.permitted,
          });
        }
        const label = command.label.trim();
        if (label.length === 0) {
          throw new DomainViolation({
            kind: 'validation',
            field: 'label',
            detail: 'must not be blank',
          });
        }

        const id = this.identifiers.apiKeyId();
        const secret = this.secrets.generate();
        await repositories.apiKeys.insert({
          id,
          label,
          role: parsed.role,
          secretDigest: this.secrets.digest(secret),
          createdAt: this.clock.now(),
        });

        return { id, secret };
      },
    );
  }
}
