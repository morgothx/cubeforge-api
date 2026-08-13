import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import type { ApiKeyId } from '../../domain/identifiers';
import type { ActorContext } from '../actor-context';
import { CLOCK, type Clock } from '../ports/clock';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { authorizeInTenant, tenantOf } from '../tenant-authorization';

export interface RevokeApiKeyCommand {
  readonly actor: ActorContext;
  readonly apiKeyId: ApiKeyId;
}

@Injectable()
export class RevokeApiKeyUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: RevokeApiKeyCommand): Promise<void> {
    await this.unitOfWork.runInTenant(
      tenantOf(command.actor),
      async (repositories) => {
        await authorizeInTenant(repositories, command.actor, ['admin']);

        // Looked up first so a key belonging to another tenant is reported as
        // absent. Revoking blind would succeed silently — the repository
        // ignores rows outside the tenant — and tell the caller nothing about
        // whether anything happened.
        const key = await repositories.apiKeys.findById(command.apiKeyId);
        if (key === null) {
          throw new DomainViolation({ kind: 'not-found' });
        }

        await repositories.apiKeys.revoke(key.id, this.clock.now());
      },
    );
  }
}
