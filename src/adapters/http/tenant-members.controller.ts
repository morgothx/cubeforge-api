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
import type { ActorContext } from '../../application/actor-context';
import { ChangeMemberRoleUseCase } from '../../application/membership/change-member-role.use-case';
import { CreateTenantMemberUseCase } from '../../application/membership/create-tenant-member.use-case';
import { ListTenantMembersUseCase } from '../../application/membership/list-tenant-members.use-case';
import { RevokeMembershipUseCase } from '../../application/membership/revoke-membership.use-case';
import { DomainViolation } from '../../domain/errors';
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

/** Administrator-facing, scoped to one tenant by the path. */
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
    @Param('tenantId') pathTenant: string,
    @Body() body: CreateTenantMemberRequest,
  ): Promise<CreatedMemberResponse> {
    const result = await this.create.execute({
      actor: actingIn(request, pathTenant),
      email: body.email,
      role: body.role,
    });
    return toCreatedMemberResponse(result);
  }

  @Get()
  async index(
    @Req() request: Request,
    @Param('tenantId') pathTenant: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<MemberResponse[]> {
    const members = await this.list.execute({
      actor: actingIn(request, pathTenant),
      includeInactive: includeInactive === 'true',
    });
    return members.map(toMemberResponse);
  }

  @Patch(':membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Req() request: Request,
    @Param('tenantId') pathTenant: string,
    @Param('membershipId') id: string,
    @Body() body: ChangeMemberRoleRequest,
  ): Promise<void> {
    await this.changeRole.execute({
      actor: actingIn(request, pathTenant),
      membershipId: membershipId(id),
      role: body.role,
    });
  }

  @Delete(':membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async destroy(
    @Req() request: Request,
    @Param('tenantId') pathTenant: string,
    @Param('membershipId') id: string,
  ): Promise<void> {
    await this.revoke.execute({
      actor: actingIn(request, pathTenant),
      membershipId: membershipId(id),
    });
  }
}

/**
 * Reconciles the tenant in the path with the tenant the caller acts in.
 *
 * Use cases take their tenant from the actor and never see this path segment,
 * so without this check a member of one tenant could address another tenant's
 * URL and silently operate on their own — confusing, and a trap for whoever
 * writes the next controller. Naming someone else's tenant is reported as
 * absence, per requirement 9.2.
 */
function actingIn(request: Request, pathTenant: string): ActorContext {
  const actor = actorOf(request);
  if (actor.kind !== 'tenant-member' || actor.tenantId !== pathTenant) {
    throw new DomainViolation({ kind: 'not-found' });
  }
  return actor;
}
