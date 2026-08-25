import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { DeclareLocationUseCase } from '../../application/inventory/declare-location.use-case';
import { ListLocationsUseCase } from '../../application/inventory/list-locations.use-case';
import { DomainViolation } from '../../domain/errors';
import { parseLocationCode } from '../../domain/inventory/identifiers';
import { Access } from './access/access.decorator';
import {
  DeclareLocationRequest,
  type CatalogueEntryResponse,
  type DeclaredResponse,
} from './dto/inventory-catalogue.dto';
import { actorOf } from './principal.middleware';

/** Where a tenant keeps stock. The catalogue's twin, route for route. */
@Controller('tenants/:tenantId/inventory/locations')
export class InventoryLocationsController {
  constructor(
    private readonly declare: DeclareLocationUseCase,
    private readonly places: ListLocationsUseCase,
  ) {}

  @Put(':code')
  @Access({ roles: ['admin', 'editor'], machines: true })
  async declareOne(
    @Req() request: Request,
    @Param('code') code: string,
    @Body() body: DeclareLocationRequest,
  ): Promise<DeclaredResponse> {
    const parsed = parseLocationCode(code);
    if (parsed.malformed) {
      throw new DomainViolation({
        kind: 'validation',
        field: 'code',
        detail: parsed.because,
      });
    }

    const outcome = await this.declare.execute({
      actor: actorOf(request),
      code: parsed.value,
      name: body.name,
    });

    return { code: parsed.value, outcome };
  }

  @Get()
  @Access({ roles: ['admin', 'editor', 'viewer'], machines: true })
  async index(@Req() request: Request): Promise<CatalogueEntryResponse[]> {
    const places = await this.places.execute({ actor: actorOf(request) });

    return places.map((place) => ({
      code: place.code,
      name: place.name,
      createdAt: place.createdAt.toISOString(),
      updatedAt: place.updatedAt.toISOString(),
    }));
  }
}
