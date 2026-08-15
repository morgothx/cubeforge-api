import { Controller, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IssueSetupTokenUseCase } from '../../application/credential/issue-setup-token.use-case';
import { personId } from '../../domain/identifiers';
import { actorOf } from './principal.middleware';
import { toSetupTokenResponse, type SetupTokenResponse } from './dto/responses';
import { Access } from './access/access.decorator';

/**
 * Operator-facing, and the only way a person ever acquires a password.
 *
 * It sits under `platform/people` beside deactivation because both are things
 * an operator does *to* a person by their platform-wide identifier, and neither
 * belongs to any tenant. The token comes back once; there is no route that
 * reads one back, because the platform stores only its digest.
 */
@Controller('platform/people/:personId/setup-tokens')
export class CredentialSetupController {
  constructor(private readonly issue: IssueSetupTokenUseCase) {}

  @Post()
  @Access({ operator: true })
  async store(
    @Req() request: Request,
    @Param('personId') id: string,
  ): Promise<SetupTokenResponse> {
    return toSetupTokenResponse(
      await this.issue.execute({
        actor: actorOf(request),
        personId: personId(id),
      }),
    );
  }
}
