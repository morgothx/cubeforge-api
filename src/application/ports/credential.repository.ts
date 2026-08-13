import type {
  PasswordDigest,
  SecretDigest,
} from '../../domain/credential/secrets';
import type { EmailAddress, PersonId } from '../../domain/identifiers';
import type { PersonStatus } from '../../domain/person/person.entity';

/**
 * What signing in needs to know about someone, in one read.
 *
 * `passwordDigest` is nullable because a person can exist without ever having
 * set a password — they were added as a member and no operator has issued them
 * a setup token yet. Sign-in must treat that case exactly like a wrong
 * password, which is easier to get right when the shape forces the caller to
 * consider it.
 */
export interface StoredCredential {
  readonly personId: PersonId;
  readonly personStatus: PersonStatus;
  readonly passwordDigest: PasswordDigest | null;
}

export interface SetupTokenRecord {
  readonly id: string;
  readonly personId: PersonId;
  readonly expiresAt: Date;
  readonly redeemedAt: Date | null;
}

/**
 * Read and write access to credentials, held only by the authenticating
 * identity. Nothing tenant-scoped can reach any of it.
 */
export interface CredentialRepository {
  findByEmail(email: EmailAddress): Promise<StoredCredential | null>;

  /**
   * Replaces any existing password rather than refusing. Requirement 1.2 makes
   * redemption the only way to set one, and an operator re-issuing a token for
   * someone who forgot is the platform's whole recovery story.
   */
  establishPassword(
    personId: PersonId,
    digest: PasswordDigest,
    at: Date,
  ): Promise<void>;

  /** Looked up by digest, because the token itself is never stored. */
  findSetupToken(digest: SecretDigest): Promise<SetupTokenRecord | null>;

  markSetupTokenRedeemed(id: string, at: Date): Promise<void>;
}

/**
 * Issuing a setup token is the operator's half, and it is deliberately a
 * different contract on a different connection: the operator may create one and
 * never read one back, the authenticator may read and retire one and never
 * create one. Neither can perform the other's half, and the database grants say
 * the same thing independently.
 */
export interface SetupTokenIssuingRepository {
  insert(token: {
    readonly id: string;
    readonly personId: PersonId;
    readonly secretDigest: SecretDigest;
    readonly expiresAt: Date;
  }): Promise<void>;
}
