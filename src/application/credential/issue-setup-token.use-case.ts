import { Inject, Injectable } from '@nestjs/common';
import type { OpaqueSecret } from '../../domain/credential/secrets';
import type { PersonId } from '../../domain/identifiers';
import type { ActorContext } from '../actor-context';
import { CLOCK, type Clock } from '../ports/clock';
import {
  IDENTIFIER_GENERATOR,
  type IdentifierGenerator,
} from '../ports/identifier-generator';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../ports/platform-unit-of-work';
import {
  SECRET_GENERATOR,
  type SecretGenerator,
} from '../ports/secret-generator';
import { requirePlatformOperator } from '../tenant-authorization';

export interface IssueSetupTokenCommand {
  readonly actor: ActorContext;
  readonly personId: PersonId;
}

/** Twenty-four hours: long enough to hand over, short enough to matter if lost. */
const VALIDITY_HOURS = 24;

/**
 * Only a platform operator may set a credential in motion.
 *
 * A credential is platform-wide, so letting a tenant administrator issue one
 * would let them seize an account that administers another tenant. That this
 * makes operators a bottleneck is a known cost, recorded in the requirements
 * rather than designed around.
 *
 * The token is returned exactly once and stored only as a digest, so the
 * platform cannot reproduce what it issued. Losing it means issuing another,
 * which is the correct outcome.
 */
@Injectable()
export class IssueSetupTokenUseCase {
  constructor(
    @Inject(PLATFORM_UNIT_OF_WORK)
    private readonly platform: PlatformUnitOfWork,
    @Inject(SECRET_GENERATOR) private readonly secrets: SecretGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTIFIER_GENERATOR)
    private readonly identifiers: IdentifierGenerator,
  ) {}

  async execute(command: IssueSetupTokenCommand): Promise<OpaqueSecret> {
    requirePlatformOperator(command.actor);

    const token = this.secrets.generate();
    const expiresAt = new Date(
      this.clock.now().getTime() + VALIDITY_HOURS * 3_600_000,
    );

    await this.platform.runAsOperator(({ setupTokens }) =>
      setupTokens.insert({
        id: this.identifiers.rowId(),
        personId: command.personId,
        secretDigest: this.secrets.digest(token),
        expiresAt,
      }),
    );

    return token;
  }
}
