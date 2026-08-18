import type { PersonId } from '../../domain/identifiers';
import type { ApiKeyResolvingRepository } from './api-key.repository';
import type { CredentialRepository } from './credential.repository';
import type { SessionRepository } from './session.repository';
import type { StandingRepository } from './standing.repository';

export const AUTHENTICATOR_UNIT_OF_WORK = Symbol('AUTHENTICATOR_UNIT_OF_WORK');

/** Whether a person is recorded as an operator. There is no way to write it. */
export interface OperatorStatusRepository {
  isOperator(personId: PersonId): Promise<boolean>;
}

export interface AuthenticatorRepositories {
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly apiKeys: ApiKeyResolvingRepository;
  readonly operators: OperatorStatusRepository;
}

/**
 * What a transaction with a person published exposes, and nothing else.
 *
 * A separate bundle rather than a field on `AuthenticatorRepositories`: were
 * `standing` reachable from `runAuthenticating`, the read would compile with
 * nobody published and quietly answer `null`. Yielding it only from
 * `runAsPerson` removes the shape of that mistake instead of forbidding it by
 * convention — the same reasoning that keeps `describeCaller()` from taking a
 * person.
 */
export interface AuthenticatingPersonRepositories {
  readonly standing: StandingRepository;
}

/**
 * The only route to anything holding secret material.
 *
 * No tenant is published here and none could be: authentication runs before a
 * tenant is known, and for an API key the tenant is what resolution produces.
 * That is why this is a separate unit of work rather than a corner of the
 * tenant-scoped one — and why the identity behind it is a separate database
 * role with different grants.
 */
export interface AuthenticatorUnitOfWork {
  runAuthenticating<T>(
    work: (repositories: AuthenticatorRepositories) => Promise<T>,
  ): Promise<T>;

  /**
   * The same identity, with one person published into the transaction so a
   * policy — not a query — confines what the reads inside it return.
   *
   * `runAuthenticating` is untouched and stays the entry point for everything
   * else: signing in runs before any person is known, and has nobody to
   * publish.
   */
  runAsPerson<T>(
    personId: PersonId,
    work: (repositories: AuthenticatingPersonRepositories) => Promise<T>,
  ): Promise<T>;
}
