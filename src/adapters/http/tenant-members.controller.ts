import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ChangeMemberRoleUseCase } from '../../application/membership/change-member-role.use-case';
import { CreateTenantMemberUseCase } from '../../application/membership/create-tenant-member.use-case';
import { ListTenantMembersUseCase } from '../../application/membership/list-tenant-members.use-case';
import { RevokeMembershipUseCase } from '../../application/membership/revoke-membership.use-case';
import { membershipId } from '../../domain/identifiers';
import { actorOf } from './principal.middleware';
import {
  ChangeMemberRoleRequest,
  CreateTenantMemberRequest,
} from './dto/requests';
import {
  toCreatedMemberResponse,
  toMemberResponse,
  type CreatedMemberResponse,
  type MemberResponse,
} from './dto/responses';

/**
 * Administrator-facing, scoped to one tenant by the path.
 *
 * Nothing here reconciles that path segment against the actor, because the
 * actor was built from it: the middleware reads the tenant from the URL and the
 * token names only a person. Whether that person may act in that tenant is
 * settled by `authorizeInTenant`, from stored records, inside the tenant
 * transaction — one check, in the layer that owns it.
 */
@Controller('tenants/:tenantId/members')
export class TenantMembersController {
  constructor(
    private readonly create: CreateTenantMemberUseCase,
    private readonly list: ListTenantMembersUseCase,
    private readonly changeRole: ChangeMemberRoleUseCase,
    private readonly revoke: RevokeMembershipUseCase,
  ) {}

  @Post()
  async store(
    @Req() request: Request,
    @Body() body: CreateTenantMemberRequest,
  ): Promise<CreatedMemberResponse> {
    const result = await this.create.execute({
      actor: actorOf(request),
      email: body.email,
      role: body.role,
    });
    return toCreatedMemberResponse(result);
  }

  @Get()
  async index(
    @Req() request: Request,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<MemberResponse[]> {
    const members = await this.list.execute({
      actor: actorOf(request),
      includeInactive: includeInactive === 'true',
    });
    return members.map(toMemberResponse);
  }

  @Patch(':membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Req() request: Request,
    @Param('membershipId') id: string,
    @Body() body: ChangeMemberRoleRequest,
  ): Promise<void> {
    await this.changeRole.execute({
      actor: actorOf(request),
      membershipId: membershipId(id),
      role: body.role,
    });
  }

  @Delete(':membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async destroy(
    @Req() request: Request,
    @Param('membershipId') id: string,
  ): Promise<void> {
    await this.revoke.execute({
      actor: actorOf(request),
      membershipId: membershipId(id),
    });
  }
}
