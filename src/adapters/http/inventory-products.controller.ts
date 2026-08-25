import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { DeclareProductUseCase } from '../../application/inventory/declare-product.use-case';
import { ListProductsUseCase } from '../../application/inventory/list-products.use-case';
import { DomainViolation } from '../../domain/errors';
import { parseSku } from '../../domain/inventory/identifiers';
import { SkipThrottle } from '@nestjs/throttler';
import { Access } from './access/access.decorator';
import { InventoryThrottlerGuard, OTHER_BUCKETS } from './inventory-throttling';
import {
  DeclareProductRequest,
  type CatalogueEntryResponse,
  type DeclaredResponse,
} from './dto/inventory-catalogue.dto';
import { actorOf } from './principal.middleware';

/**
 * The product catalogue of one tenant.
 *
 * **Under `/tenants/:tenantId/` for a reason the guard makes non-negotiable.**
 * A person's tenant is read from the path; a machine's comes from its key, and
 * the guard refuses a key on any route that names no tenant, because there is
 * nothing to confine it against. A route at `/inventory/products` would have
 * been unreachable by the audience this whole feature exists for.
 *
 * These are the first routes on the platform to declare `machines: true`.
 */
@Controller('tenants/:tenantId/inventory/products')
@UseGuards(InventoryThrottlerGuard)
@SkipThrottle(OTHER_BUCKETS)
export class InventoryProductsController {
  constructor(
    private readonly declare: DeclareProductUseCase,
    private readonly catalogue: ListProductsUseCase,
  ) {}

  @Put(':sku')
  @Access({ roles: ['admin', 'editor'], machines: true })
  async declareOne(
    @Req() request: Request,
    @Param('sku') sku: string,
    @Body() body: DeclareProductRequest,
  ): Promise<DeclaredResponse> {
    const parsed = parseSku(sku);
    if (parsed.malformed) {
      throw new DomainViolation({
        kind: 'validation',
        field: 'sku',
        detail: parsed.because,
      });
    }

    const outcome = await this.declare.execute({
      actor: actorOf(request),
      sku: parsed.value,
      name: body.name,
      category: body.category ?? null,
    });

    return { code: parsed.value, outcome };
  }

  @Get()
  @Access({ roles: ['admin', 'editor', 'viewer'], machines: true })
  async index(@Req() request: Request): Promise<CatalogueEntryResponse[]> {
    const products = await this.catalogue.execute({ actor: actorOf(request) });

    return products.map((product) => ({
      code: product.code,
      name: product.name,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    }));
  }
}
