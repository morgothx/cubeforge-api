import { Global, Module } from '@nestjs/common';
import { CorrelationMiddleware } from './adapters/http/correlation.middleware';
import { SystemClock } from './adapters/system/system-clock';
import { UuidIdentifierGenerator } from './adapters/system/uuid-identifier-generator';
import { CLOCK } from './application/ports/clock';
import { IDENTIFIER_GENERATOR } from './application/ports/identifier-generator';

/**
 * Time, identity generation and request correlation: what every feature needs
 * and none owns.
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
    CorrelationMiddleware,
  ],
  exports: [CLOCK, IDENTIFIER_GENERATOR, CorrelationMiddleware],
})
export class SystemModule {}
