import { Global, Module } from '@nestjs/common';
import { SystemClock } from './adapters/system/system-clock';
import { UuidIdentifierGenerator } from './adapters/system/uuid-identifier-generator';
import { CLOCK } from './application/ports/clock';
import { IDENTIFIER_GENERATOR } from './application/ports/identifier-generator';

/**
 * Time and identity generation, which every feature needs and none owns.
 *
 * They lived in the identity module until authentication needed them too.
 * Duplicating the providers would have worked — both are stateless — but two
 * modules quietly answering the same question is how they drift.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: IDENTIFIER_GENERATOR, useClass: UuidIdentifierGenerator },
  ],
  exports: [CLOCK, IDENTIFIER_GENERATOR],
})
export class SystemModule {}
