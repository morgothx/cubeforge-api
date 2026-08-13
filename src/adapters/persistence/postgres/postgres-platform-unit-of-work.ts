import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type {
  PlatformRepositories,
  PlatformUnitOfWork,
} from '../../../application/ports/platform-unit-of-work';
import type { SetupTokenIssuingRepository } from '../../../application/ports/credential.repository';
import type { PlatformPersonRepository } from '../../../application/ports/person.repository';
import type { TenantRepository } from '../../../application/ports/tenant.repository';
import type { SecretDigest } from '../../../domain/credential/secrets';
import type { PersonId, TenantId } from '../../../domain/identifiers';
import type {
  Tenant,
  TenantStatus,
} from '../../../domain/tenant/tenant.entity';
import { OPERATOR_DATABASE, type Database } from './drizzle.module';
import { translateConstraintViolation } from './postgres-errors';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';
import { toTenant } from './row-mapping';
import { credentialSetupTokens, tenants } from './schema';

/**
 * Operator transactions, on a separate connection as `cubeforge_operator`.
 *
 * No tenant is published here, and none would help: the operator identity holds
 * no grant on `memberships` at all, so requirement 3.2 holds even against
 * hand-written SQL on this connection. There is deliberately no membership
 * repository to hand out either — the boundary is enforced twice, by the
 * missing method and by the missing privilege.
 */
@Injectable()
export class PostgresPlatformUnitOfWork implements PlatformUnitOfWork {
  constructor(@Inject(OPERATOR_DATABASE) private readonly database: Database) {}

  runAsOperator<T>(
    work: (repositories: PlatformRepositories) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction((tx) =>
      work({
        tenants: new PostgresTenantRepository(tx),
        people: new PostgresPlatformPersonRepository(tx),
        setupTokens: new PostgresSetupTokenIssuingRepository(tx),
      }),
    );
  }
}

class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly tx: Transaction) {}

  async findById(id: TenantId): Promise<Tenant | null> {
    const rows = await this.tx
      .select()
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    return rows.length === 0 ? null : toTenant(rows[0]);
  }

  async list(): Promise<Tenant[]> {
    const rows = await this.tx
      .select()
      .from(tenants)
      .orderBy(tenants.createdAt);
    return rows.map(toTenant);
  }

  async insert(tenant: Tenant): Promise<void> {
    try {
      await this.tx.insert(tenants).values({
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        createdAt: tenant.createdAt,
      });
    } catch (error) {
      translateConstraintViolation(error, {
        tenants_name_unique: { kind: 'tenant-name-taken' },
      });
    }
  }

  async updateStatus(id: TenantId, status: TenantStatus): Promise<void> {
    await this.tx.update(tenants).set({ status }).where(eq(tenants.id, id));
  }
}

class PostgresPlatformPersonRepository implements PlatformPersonRepository {
  constructor(private readonly tx: Transaction) {}

  /**
   * Goes through a function rather than an UPDATE. The operator holds no SELECT
   * grant on `people`, and a `WHERE id = ...` reads a column — so a targeted
   * update is rejected outright, while an unqualified one would hit every row.
   * Migration 0004 records the finding; this is the only route left.
   *
   * Nothing comes back, including whether the identifier matched anything. That
   * is requirement 3.3 rather than an oversight.
   */
  async deactivate(personId: PersonId): Promise<void> {
    await this.tx.execute(sql`select deactivate_person(${personId}::uuid)`);
  }
}

/**
 * The operator's whole reach over setup tokens: creating one. There is no read
 * and no update here, and the grant in migration 0006 says the same — an
 * operator who could retire a token could suppress evidence of issuing it.
 */
class PostgresSetupTokenIssuingRepository implements SetupTokenIssuingRepository {
  constructor(private readonly tx: Transaction) {}

  async insert(token: {
    readonly id: string;
    readonly personId: PersonId;
    readonly secretDigest: SecretDigest;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.tx.insert(credentialSetupTokens).values({
      id: token.id,
      personId: token.personId,
      secretDigest: token.secretDigest,
      expiresAt: token.expiresAt,
    });
  }
}
