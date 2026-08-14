import { Inject, Injectable } from '@nestjs/common';
import { decideRefresh } from '../../domain/credential/session';
import type { OpaqueSecret } from '../../domain/credential/secrets';
import { DomainViolation } from '../../domain/errors';
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
import {
  SECRET_GENERATOR,
  type SecretGenerator,
} from '../ports/secret-generator';
import type { IssuedSession } from './sign-in.use-case';

export interface RefreshSessionCommand {
  readonly refreshToken: OpaqueSecret;
}

/**
 * Exchanges a refresh token for a new pair, and retires the one presented.
 *
 * The decision of whether a token may be exchanged belongs to the domain; this
 * orchestrates the consequences. Every rejection is the same rejection, so a
 * caller cannot learn whether their token expired, was already used, or never
 * existed.
 */
@Injectable()
export class RefreshSessionUseCase {
  constructor(
    @Inject(AUTHENTICATOR_UNIT_OF_WORK)
    private readonly authenticator: AuthenticatorUnitOfWork,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly tokens: AccessTokenIssuer,
    @Inject(SECRET_GENERATOR) private readonly secrets: SecretGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTIFIER_GENERATOR)
    private readonly identifiers: IdentifierGenerator,
  ) {}

  async execute(command: RefreshSessionCommand): Promise<IssuedSession> {
    const now = this.clock.now();

    /**
     * The refusals here have work to do — ending a family, ending a person's
     * sessions — and throwing inside the transaction would roll that work back
     * along with everything else. So the transaction reports its verdict and
     * the rejection is raised after it has committed. A refusal reports itself
     * as the phrase to be logged; a success reports the session.
     */
    const outcome = await this.authenticator.runAuthenticating(
      async ({ credentials, sessions }) => {
        const presented = await sessions.findByDigest(
          this.secrets.digest(command.refreshToken),
        );
        if (presented === null) {
          return 'no session holds this refresh token';
        }

        const decision = decideRefresh(presented, now);
        if (decision.outcome === 'reject-and-invalidate-family') {
          // A token presented twice means someone else may hold a copy. The
          // legitimate holder and a thief cannot both continue, so neither does.
          await sessions.invalidateFamily(presented.signInId, now);
          return 'this refresh token was presented twice; the family is now invalid';
        }
        if (decision.outcome === 'reject') {
          return 'this refresh token is expired or already invalidated';
        }

        // Requirement 6.1. Checked here rather than only at sign-in, because a
        // person deactivated mid-session must not be able to extend it.
        const person = await credentials.findByPerson(presented.personId);
        if (person === null || person.personStatus !== 'active') {
          await sessions.invalidateAllForPerson(presented.personId, now);
          return 'this person is no longer active; their sessions have ended';
        }

        await sessions.markExchanged(presented.id, now);

        const refreshToken = this.secrets.generate();
        await sessions.insert({
          id: this.identifiers.rowId(),
          // The successor inherits the family and the deadline: rotating must
          // not extend a session, only continue it.
          signInId: presented.signInId,
          personId: presented.personId,
          secretDigest: this.secrets.digest(refreshToken),
          sessionExpiresAt: presented.sessionExpiresAt,
        });

        return {
          accessToken: await this.tokens.issue(presented.personId, now),
          refreshToken,
          sessionExpiresAt: presented.sessionExpiresAt,
        };
      },
    );

    if (typeof outcome === 'string') {
      throw new DomainViolation({ kind: 'not-found' }, outcome);
    }
    return outcome;
  }
}
