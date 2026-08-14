import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DeactivatePersonUseCase } from '../../application/person/deactivate-person.use-case';
import { personId } from '../../domain/identifiers';
import { actorOf } from './principal.middleware';

/**
 * Operator-facing, and deliberately the only route that names a person by their
 * platform-wide identifier. There is no GET here: requirement 3.3 forbids
 * telling an operator anything about a person, including whether they exist.
 */
@Controller('platform/people')
export class PlatformPeopleController {
  constructor(private readonly deactivate: DeactivatePersonUseCase) {}

  @Delete(':personId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async destroy(
    @Req() request: Request,
    @Param('personId') id: string,
  ): Promise<void> {
    await this.deactivate.execute({
      actor: actorOf(request),
      personId: personId(id),
    });
  }
}
