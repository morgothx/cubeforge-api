import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  TenantScopedRepositories,
  TenantScopedUnitOfWork,
} from '../../../application/ports/tenant-scoped-unit-of-work';
import type { TenantId } from '../../../domain/identifiers';
import { APP_DATABASE, type Database } from './drizzle.module';
import { PostgresApiKeyRepository } from './postgres-api-key.repository';
import { PostgresLocationRepository } from './postgres-location.repository';
import { PostgresMembershipRepository } from './postgres-membership.repository';
import { PostgresMovementRepository } from './postgres-movement.repository';
import { PostgresPersonRepository } from './postgres-person.repository';
import { PostgresProductRepository } from './postgres-product.repository';
import { PostgresTenantReadRepository } from './postgres-tenant-read.repository';

/** The handle Drizzle hands to a transaction callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Opens a transaction as the tenant-scoped runtime identity, publishes the
 * tenant into it, and exposes the repositories only for its duration.
 *
 * `set_config(..., true)` is transaction-local. That third argument is the
 * whole point: connections are pooled, and a session-level setting would stay
 * on the connection after it returns to the pool and silently scope the next
 * request to the previous request's tenant. The transaction-local form is
 * discarded at COMMIT and ROLLBACK alike, so a connection can never carry a
 * tenant forward.
 *
 * The identity here is never the schema owner. An owner bypasses row-level
 * security unless FORCE is set, and relying on FORCE alone would make the
 * separation of identities decorative.
 */
@Injectable()
export class PostgresTenantScopedUnitOfWork implements TenantScopedUnitOfWork {
  constructor(@Inject(APP_DATABASE) private readonly database: Database) {}

  runInTenant<T>(
    tenantId: TenantId,
    work: (repositories: TenantScopedRepositories) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.current_tenant', ${tenantId}, true)`,
      );

      return work(repositoriesFor(tx, tenantId));
    });
  }
}

/**
 * Repositories are built per transaction and closed over both the transaction
 * and the tenant, so no query can run outside the context that authorizes it.
 */
export function repositoriesFor(
  tx: Transaction,
  tenantId: TenantId,
): TenantScopedRepositories {
  return {
    tenants: new PostgresTenantReadRepository(tx, tenantId),
    people: new PostgresPersonRepository(tx, tenantId),
    memberships: new PostgresMembershipRepository(tx, tenantId),
    apiKeys: new PostgresApiKeyRepository(tx, tenantId),
    products: new PostgresProductRepository(tx, tenantId),
    locations: new PostgresLocationRepository(tx, tenantId),
    movements: new PostgresMovementRepository(tx, tenantId),
  };
}
