import { Inject, Injectable } from '@nestjs/common';
import { assertPasswordAcceptable } from '../../domain/credential/password-policy';
import type { OpaqueSecret } from '../../domain/credential/secrets';
import { DomainViolation } from '../../domain/errors';
import {
  AUTHENTICATOR_UNIT_OF_WORK,
  type AuthenticatorUnitOfWork,
} from '../ports/authenticator-unit-of-work';
import { CLOCK, type Clock } from '../ports/clock';
import { PASSWORD_HASHER, type PasswordHasher } from '../ports/password-hasher';
import {
  SECRET_GENERATOR,
  type SecretGenerator,
} from '../ports/secret-generator';

export interface RedeemSetupTokenCommand {
  readonly token: OpaqueSecret;
  readonly password: string;
}

/**
 * Redeeming needs no actor: holding the token *is* the claim. That is why the
 * token is single-use, short-lived, and never stored in a form the platform
 * could hand out again.
 *
 * Every way a token can fail — already redeemed, expired, never issued —
 * produces one response (1.3). Telling them apart would let someone with a
 * guessed value learn whether it had ever existed.
 */
@Injectable()
export class RedeemSetupTokenUseCase {
  constructor(
    @Inject(AUTHENTICATOR_UNIT_OF_WORK)
    private readonly authenticator: AuthenticatorUnitOfWork,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SECRET_GENERATOR) private readonly secrets: SecretGenerator,
  ) {}

  async execute(command: RedeemSetupTokenCommand): Promise<void> {
    // Checked before the token is even looked up, so a mistyped password costs
    // the holder nothing: their one token survives to be used properly.
    assertPasswordAcceptable(command.password);

    const digest = await this.hasher.hash(command.password);
    const now = this.clock.now();

    await this.authenticator.runAuthenticating(
      async ({ credentials, sessions }) => {
        const token = await credentials.findSetupToken(
          this.secrets.digest(command.token),
        );
        const usable =
          token !== null &&
          token.redeemedAt === null &&
          token.expiresAt.getTime() > now.getTime();
        if (!usable) {
          throw new DomainViolation({ kind: 'not-found' });
        }

        await credentials.markSetupTokenRedeemed(token.id, now);
        await credentials.establishPassword(token.personId, digest, now);

        // Requirement 1.5. If an operator seized this account, the person whose
        // sessions just ended is the one who finds out — which is the whole
        // mitigation the requirements claim for that risk.
        await sessions.invalidateAllForPerson(token.personId, now);
      },
    );
  }
}
