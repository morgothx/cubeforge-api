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
import { DeactivateTenantUseCase } from '../../application/tenant/deactivate-tenant.use-case';
import { ListTenantsUseCase } from '../../application/tenant/list-tenants.use-case';
import { ProvisionTenantUseCase } from '../../application/tenant/provision-tenant.use-case';
import { tenantId } from '../../domain/identifiers';
import { actorOf } from './principal.middleware';
import { CreateTenantRequest } from './dto/requests';
import {
  toProvisionedTenantResponse,
  toTenantResponse,
  type ProvisionedTenantResponse,
  type TenantResponse,
} from './dto/responses';

/** Operator-facing. Every method here refuses a tenant member. */
@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly provision: ProvisionTenantUseCase,
    private readonly list: ListTenantsUseCase,
    private readonly deactivate: DeactivateTenantUseCase,
  ) {}

  @Post()
  async create(
    @Req() request: Request,
    @Body() body: CreateTenantRequest,
  ): Promise<ProvisionedTenantResponse> {
    return toProvisionedTenantResponse(
      await this.provision.execute({
        actor: actorOf(request),
        name: body.name,
        administratorEmail: body.administratorEmail,
      }),
    );
  }

  @Get()
  async index(@Req() request: Request): Promise<TenantResponse[]> {
    const tenants = await this.list.execute({ actor: actorOf(request) });
    return tenants.map(toTenantResponse);
  }

  /**
   * DELETE, but the record is retained and only its status changes (2.3). The
   * verb describes what the caller is asking for; requirement 2.1 decides what
   * the system does about it.
   */
  @Delete(':tenantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async destroy(
    @Req() request: Request,
    @Param('tenantId') id: string,
  ): Promise<void> {
    await this.deactivate.execute({
      actor: actorOf(request),
      tenantId: tenantId(id),
    });
  }
}
