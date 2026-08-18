import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { DescribeCallerUseCase } from '../../application/identity/describe-caller.use-case';
import { Access } from './access/access.decorator';
import { actorOf } from './principal.middleware';
import { toCallerResponse, type CallerResponse } from './dto/responses';

/**
 * What the caller may know about themselves.
 *
 * The route takes no parameter, and that is the design rather than an
 * omission: requirement 2.3 forbids an operation that reports another person's
 * standing, and a route with nothing to name cannot be that operation. The
 * subject is whoever the credential resolved to, which the middleware attached
 * and nothing here can override.
 *
 * `{ person: true }` is the declaration this feature added. A member and an
 * operator both reach it; a machine does not, because an API key names a
 * credential rather than a person and has no standing to describe.
 */
@Controller('me')
export class CallerController {
  constructor(private readonly describe: DescribeCallerUseCase) {}

  @Get()
  @Access({ person: true })
  async show(@Req() request: Request): Promise<CallerResponse> {
    return toCallerResponse(
      await this.describe.execute({ actor: actorOf(request) }),
    );
  }
}
