import { Inject, Injectable } from '@nestjs/common';
import type { OpaqueSecret } from '../../domain/credential/secrets';
import {
  AUTHENTICATOR_UNIT_OF_WORK,
  type AuthenticatorUnitOfWork,
} from '../ports/authenticator-unit-of-work';
import { CLOCK, type Clock } from '../ports/clock';
import {
  SECRET_GENERATOR,
  type SecretGenerator,
} from '../ports/secret-generator';

export interface SignOutCommand {
  readonly refreshToken: OpaqueSecret;
  readonly everywhere: boolean;
}

/**
 * Ends one session, or all of them.
 *
 * An unrecognized token succeeds silently. Signing out is not an operation
 * worth guarding: reporting that the token was unknown would tell an attacker
 * holding a guessed value that it never existed, and there is nothing to gain
 * by refusing a request whose only effect is to remove access.
 */
@Injectable()
export class SignOutUseCase {
  constructor(
    @Inject(AUTHENTICATOR_UNIT_OF_WORK)
    private readonly authenticator: AuthenticatorUnitOfWork,
    @Inject(SECRET_GENERATOR) private readonly secrets: SecretGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: SignOutCommand): Promise<void> {
    const now = this.clock.now();

    await this.authenticator.runAuthenticating(async ({ sessions }) => {
      const presented = await sessions.findByDigest(
        this.secrets.digest(command.refreshToken),
      );
      if (presented === null) {
        return;
      }

      await (command.everywhere
        ? sessions.invalidateAllForPerson(presented.personId, now)
        : sessions.invalidateFamily(presented.signInId, now));
    });
  }
}
