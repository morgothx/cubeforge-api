import { Inject, Injectable } from '@nestjs/common';
import type { PersonId } from '../../domain/identifiers';
import type { ActorContext } from '../actor-context';
import {
  PLATFORM_UNIT_OF_WORK,
  type PlatformUnitOfWork,
} from '../ports/platform-unit-of-work';
import { requirePlatformOperator } from '../tenant-authorization';

export interface DeactivatePersonCommand {
  readonly actor: ActorContext;
  readonly personId: PersonId;
}

/**
 * Deactivating a person is a platform act, not a tenant one: it takes effect in
 * every tenant at once (8.1) while every membership is retained (8.2).
 *
 * An unknown identifier reports success. The operator holds no read grant on
 * people, so the use case genuinely cannot tell — and reporting not-found would
 * answer whether a person exists on the platform, which requirement 3.3 forbids.
 */
@Injectable()
export class DeactivatePersonUseCase {
  constructor(
    @Inject(PLATFORM_UNIT_OF_WORK)
    private readonly platform: PlatformUnitOfWork,
  ) {}

  async execute(command: DeactivatePersonCommand): Promise<void> {
    requirePlatformOperator(command.actor);

    await this.platform.runAsOperator(({ people }) =>
      people.updateStatus(command.personId, 'deactivated'),
    );
  }
}
