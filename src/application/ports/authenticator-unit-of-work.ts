import type { PersonId } from '../../domain/identifiers';
import type { ApiKeyResolvingRepository } from './api-key.repository';
import type { CredentialRepository } from './credential.repository';
import type { SessionRepository } from './session.repository';

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
}
