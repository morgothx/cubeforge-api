import { Inject, Injectable } from '@nestjs/common';
import { sessionDeadline } from '../../domain/credential/session';
import type {
  AccessToken,
  OpaqueSecret,
} from '../../domain/credential/secrets';
import { DomainViolation } from '../../domain/errors';
import { emailAddress } from '../../domain/identifiers';
import {
  ACCESS_TOKEN_ISSUER,
  type AccessTokenIssuer,
} from '../ports/access-token-issuer';
import {
  AUTHENTICATOR_UNIT_OF_WORK,
  type AuthenticatorUnitOfWork,
} from '../ports/authenticator-unit-of-work';
import { CLOCK, type Clock } from '../ports/clock';
import {
  IDENTIFIER_GENERATOR,
  type IdentifierGenerator,
} from '../ports/identifier-generator';
import { PASSWORD_HASHER, type PasswordHasher } from '../ports/password-hasher';
import {
  SECRET_GENERATOR,
  type SecretGenerator,
} from '../ports/secret-generator';

export interface SignInCommand {
  readonly email: string;
  readonly password: string;
}

export interface IssuedSession {
  readonly accessToken: AccessToken;
  readonly refreshToken: OpaqueSecret;
  readonly sessionExpiresAt: Date;
}

/**
 * Every way sign-in can fail produces one rejection, and every path performs a
 * password verification before reaching it.
 *
 * An unknown address, an address with no password, a deactivated person and a
 * wrong password are four different facts, and disclosing which one applied
 * would let anyone enumerate the platform's users. The response says nothing —
 * and neither does the time it takes, because the paths that have no digest to
 * compare against verify a decoy at the same cost.
 */
@Injectable()
export class SignInUseCase {
  constructor(
    @Inject(AUTHENTICATOR_UNIT_OF_WORK)
    private readonly authenticator: AuthenticatorUnitOfWork,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly tokens: AccessTokenIssuer,
    @Inject(SECRET_GENERATOR) private readonly secrets: SecretGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTIFIER_GENERATOR)
    private readonly identifiers: IdentifierGenerator,
  ) {}

  async execute(command: SignInCommand): Promise<IssuedSession> {
    const now = this.clock.now();

    return this.authenticator.runAuthenticating(
      async ({ credentials, sessions }) => {
        const found = await credentials.findByEmail(this.parse(command.email));

        // The decoy paths and the real one differ only in which digest is
        // compared. Returning early anywhere above would make the difference
        // measurable.
        const authenticated =
          found?.passwordDigest != null && found.personStatus === 'active'
            ? await this.hasher.verify(command.password, found.passwordDigest)
            : await this.hasher.verifyAgainstDecoy(command.password);

        if (!authenticated || found === null) {
          throw new DomainViolation({ kind: 'not-found' });
        }

        const signInId = this.identifiers.signInId();
        const refreshToken = this.secrets.generate();
        const sessionExpiresAt = sessionDeadline(now);

        await sessions.insert({
          id: this.identifiers.rowId(),
          signInId,
          personId: found.personId,
          secretDigest: this.secrets.digest(refreshToken),
          sessionExpiresAt,
        });

        return {
          accessToken: await this.tokens.issue(found.personId, now),
          refreshToken,
          sessionExpiresAt,
        };
      },
    );
  }

  /**
   * A malformed address is rejected exactly like an unknown one. Reporting it
   * as invalid would be a small, reliable oracle: it tells the caller their
   * guess was never going to match, which is information the other paths
   * withhold.
   */
  private parse(value: string) {
    try {
      return emailAddress(value);
    } catch {
      throw new DomainViolation({ kind: 'not-found' });
    }
  }
}
