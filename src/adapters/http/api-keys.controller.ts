import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IssueApiKeyUseCase } from '../../application/api-key/issue-api-key.use-case';
import { ListApiKeysUseCase } from '../../application/api-key/list-api-keys.use-case';
import { RevokeApiKeyUseCase } from '../../application/api-key/revoke-api-key.use-case';
import { apiKeyId } from '../../domain/identifiers';
import { actorOf } from './principal.middleware';
import { IssueApiKeyRequest } from './dto/requests';
import {
  toApiKeyResponse,
  toIssuedApiKeyResponse,
  type ApiKeyResponse,
  type IssuedApiKeyResponse,
} from './dto/responses';

/**
 * Administrator-facing, scoped to one tenant by the path, exactly like the
 * member routes: the principal is built from that path segment, and the use
 * case then resolves the membership behind it, so an administrator of one
 * tenant addressing another's keys is refused as an absent record.
 *
 * The secret appears in exactly one place in this contract: the response to
 * `POST`. Listing returns summaries, and there is no route that reads a key
 * back, because the tenant's copy is the only one that exists.
 */
@Controller('tenants/:tenantId/api-keys')
export class ApiKeysController {
  constructor(
    private readonly issue: IssueApiKeyUseCase,
    private readonly list: ListApiKeysUseCase,
    private readonly revoke: RevokeApiKeyUseCase,
  ) {}

  @Post()
  async store(
    @Req() request: Request,
    @Body() body: IssueApiKeyRequest,
  ): Promise<IssuedApiKeyResponse> {
    return toIssuedApiKeyResponse(
      await this.issue.execute({
        actor: actorOf(request),
        label: body.label,
        role: body.role,
      }),
    );
  }

  @Get()
  async index(@Req() request: Request): Promise<ApiKeyResponse[]> {
    const keys = await this.list.execute({
      actor: actorOf(request),
    });
    return keys.map(toApiKeyResponse);
  }

  @Delete(':apiKeyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async destroy(
    @Req() request: Request,
    @Param('apiKeyId') id: string,
  ): Promise<void> {
    await this.revoke.execute({
      actor: actorOf(request),
      apiKeyId: apiKeyId(id),
    });
  }
}
