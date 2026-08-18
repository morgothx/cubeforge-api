import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type {
  ApiKeyResolvingRepository,
  ResolvedApiKey,
} from '../../../application/ports/api-key.repository';
import type {
  AuthenticatingPersonRepositories,
  AuthenticatorRepositories,
  AuthenticatorUnitOfWork,
  OperatorStatusRepository,
} from '../../../application/ports/authenticator-unit-of-work';
import type {
  CredentialRepository,
  SetupTokenRecord,
  StoredCredential,
} from '../../../application/ports/credential.repository';
import type {
  SessionRepository,
  StoredRefreshToken,
} from '../../../application/ports/session.repository';
import {
  passwordDigest,
  type PasswordDigest,
  type SecretDigest,
} from '../../../domain/credential/secrets';
import {
  apiKeyId,
  personId as toPersonId,
  signInId as toSignInId,
  tenantId as toTenantId,
  type ApiKeyId,
  type EmailAddress,
  type PersonId,
  type SignInId,
} from '../../../domain/identifiers';
import { parseRole } from '../../../domain/membership/role';
import { AUTHENTICATOR_DATABASE, type Database } from './drizzle.module';
import { PostgresStandingRepository } from './postgres-standing.repository';
import type { Transaction } from './postgres-tenant-scoped-unit-of-work';
import { narrowPersonStatus } from './row-mapping';
import {
  apiKeys,
  credentialSetupTokens,
  people,
  personCredentials,
  platformOperators,
  refreshTokens,
  tenants,
} from './schema';

/**
 * Transactions on the authenticating connection.
 *
 * No tenant is published and none could be: authentication runs before a tenant
 * is known, and for an API key the tenant is what resolution produces. This is
 * the only identity that may read secret material, and it holds no grant on any
 * tenant-owned table.
 */
@Injectable()
export class PostgresAuthenticatorUnitOfWork implements AuthenticatorUnitOfWork {
  constructor(
    @Inject(AUTHENTICATOR_DATABASE) private readonly database: Database,
  ) {}

  runAuthenticating<T>(
    work: (repositories: AuthenticatorRepositories) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction((tx) =>
      work({
        credentials: new PostgresCredentialRepository(tx),
        sessions: new PostgresSessionRepository(tx),
        apiKeys: new PostgresApiKeyResolvingRepository(tx),
        operators: new PostgresOperatorStatusRepository(tx),
      }),
    );
  }

  /**
   * The same identity, with one person published so the policy on
   * `memberships` — added in migration 0011 — confines the read to their rows.
   *
   * `set_config(..., true)` is transaction-local, for the reason the tenant is:
   * connections are pooled, and a session-level setting would carry the person
   * into whatever request took the connection next. The bundle is deliberately
   * narrow — nothing that writes belongs in a transaction opened to answer a
   * question about the caller.
   */
  runAsPerson<T>(
    personId: PersonId,
    work: (repositories: AuthenticatingPersonRepositories) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.current_person', ${personId}, true)`,
      );

      return work({ standing: new PostgresStandingRepository(tx) });
    });
  }
}

class PostgresCredentialRepository implements CredentialRepository {
  constructor(private readonly tx: Transaction) {}

  findByEmail(email: EmailAddress): Promise<StoredCredential | null> {
    return this.find(eq(people.email, email));
  }

  findByPerson(personId: PersonId): Promise<StoredCredential | null> {
    return this.find(eq(people.id, personId));
  }

  /**
   * A left join, not an inner one: a person may exist with no password at all,
   * and sign-in has to tell that apart from an unknown address internally while
   * answering both the same way.
   */
  private async find(
    predicate: ReturnType<typeof eq>,
  ): Promise<StoredCredential | null> {
    const rows = await this.tx
      .select({
        id: people.id,
        status: people.status,
        digest: personCredentials.passwordDigest,
      })
      .from(people)
      .leftJoin(personCredentials, eq(personCredentials.personId, people.id))
      .where(predicate)
      .limit(1);

    if (rows.length === 0) {
      return null;
    }
    const [row] = rows;
    return {
      personId: toPersonId(row.id),
      personStatus: narrowPersonStatus(row.status),
      passwordDigest: row.digest === null ? null : passwordDigest(row.digest),
    };
  }

  async establishPassword(
    personId: PersonId,
    digest: PasswordDigest,
    at: Date,
  ): Promise<void> {
    await this.tx
      .insert(personCredentials)
      .values({ personId, passwordDigest: digest, updatedAt: at })
      .onConflictDoUpdate({
        target: personCredentials.personId,
        set: { passwordDigest: digest, updatedAt: at },
      });
  }

  async findSetupToken(digest: SecretDigest): Promise<SetupTokenRecord | null> {
    const rows = await this.tx
      .select()
      .from(credentialSetupTokens)
      .where(eq(credentialSetupTokens.secretDigest, digest))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }
    const [row] = rows;
    return {
      id: row.id,
      personId: toPersonId(row.personId),
      expiresAt: row.expiresAt,
      redeemedAt: row.redeemedAt,
    };
  }

  /** Only an unredeemed token is marked, so the first redemption is the one recorded. */
  async markSetupTokenRedeemed(id: string, at: Date): Promise<void> {
    await this.tx
      .update(credentialSetupTokens)
      .set({ redeemedAt: at })
      .where(
        and(
          eq(credentialSetupTokens.id, id),
          isNull(credentialSetupTokens.redeemedAt),
        ),
      );
  }
}

class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly tx: Transaction) {}

  async insert(token: {
    readonly id: string;
    readonly signInId: SignInId;
    readonly personId: PersonId;
    readonly secretDigest: SecretDigest;
    readonly sessionExpiresAt: Date;
  }): Promise<void> {
    await this.tx.insert(refreshTokens).values(token);
  }

  async findByDigest(digest: SecretDigest): Promise<StoredRefreshToken | null> {
    const rows = await this.tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.secretDigest, digest))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }
    const [row] = rows;
    return {
      id: row.id,
      signInId: toSignInId(row.signInId),
      personId: toPersonId(row.personId),
      sessionExpiresAt: row.sessionExpiresAt,
      exchangedAt: row.exchangedAt,
      invalidatedAt: row.invalidatedAt,
    };
  }

  async markExchanged(id: string, at: Date): Promise<void> {
    await this.tx
      .update(refreshTokens)
      .set({ exchangedAt: at })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.exchangedAt)));
  }

  invalidateFamily(signInId: SignInId, at: Date): Promise<void> {
    return this.invalidate(eq(refreshTokens.signInId, signInId), at);
  }

  invalidateAllForPerson(personId: PersonId, at: Date): Promise<void> {
    return this.invalidate(eq(refreshTokens.personId, personId), at);
  }

  /**
   * Already-invalidated rows are left alone, so the moment a session ended is
   * not overwritten by a later, broader invalidation.
   */
  private async invalidate(
    predicate: ReturnType<typeof eq>,
    at: Date,
  ): Promise<void> {
    await this.tx
      .update(refreshTokens)
      .set({ invalidatedAt: at })
      .where(and(predicate, isNull(refreshTokens.invalidatedAt)));
  }
}

class PostgresApiKeyResolvingRepository implements ApiKeyResolvingRepository {
  constructor(private readonly tx: Transaction) {}

  /**
   * Unscoped by necessity: the key is what names the tenant. A revoked key and
   * a key of an inactive tenant both resolve to nothing, so requirement 6.3
   * needs no separate check by any caller.
   */
  async resolve(digest: SecretDigest): Promise<ResolvedApiKey | null> {
    const rows = await this.tx
      .select({
        id: apiKeys.id,
        tenantId: apiKeys.tenantId,
        role: apiKeys.role,
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .where(
        and(
          eq(apiKeys.secretDigest, digest),
          isNull(apiKeys.revokedAt),
          eq(tenants.status, 'active'),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }
    const [row] = rows;
    const role = parseRole(row.role);
    if (!role.ok) {
      throw new Error(`api_keys.role holds "${row.role}", which is not a role`);
    }
    return {
      id: apiKeyId(row.id),
      tenantId: toTenantId(row.tenantId),
      role: role.role,
    };
  }

  async recordUse(id: ApiKeyId, at: Date): Promise<void> {
    await this.tx
      .update(apiKeys)
      .set({ lastUsedAt: at })
      .where(eq(apiKeys.id, id));
  }
}

class PostgresOperatorStatusRepository implements OperatorStatusRepository {
  constructor(private readonly tx: Transaction) {}

  /**
   * Read on every request rather than carried in a token, so withdrawing
   * operator status takes effect immediately (requirement 11.4).
   *
   * The join is not decoration. Deactivating a person platform-wide already
   * ends their access as a member, because membership resolution reads their
   * status; without this it would not end their access as an operator, and
   * deactivating a compromised operator would be the one case where the act
   * does the least.
   */
  async isOperator(personId: PersonId): Promise<boolean> {
    const rows = await this.tx
      .select({ present: sql<number>`1` })
      .from(platformOperators)
      .innerJoin(people, eq(people.id, platformOperators.personId))
      .where(
        and(
          eq(platformOperators.personId, personId),
          eq(people.status, 'active'),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }
}
