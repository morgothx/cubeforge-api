import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../actor-context';
import type { ApiKeySummary } from '../ports/api-key.repository';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { authorizeInTenant, tenantOf } from '../tenant-authorization';

export interface ListApiKeysQuery {
  readonly actor: ActorContext;
}

/**
 * Administrators only. A key grants access to the tenant's data, so who holds
 * one is administrative knowledge — and requirement 7.5 exists partly so the
 * administrators who inherit a departed colleague's keys can see them.
 */
@Injectable()
export class ListApiKeysUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly unitOfWork: TenantScopedUnitOfWork,
  ) {}

  async execute(query: ListApiKeysQuery): Promise<ApiKeySummary[]> {
    return this.unitOfWork.runInTenant(
      tenantOf(query.actor),
      async (repositories) => {
        await authorizeInTenant(repositories, query.actor, ['admin']);
        return repositories.apiKeys.list();
      },
    );
  }
}
