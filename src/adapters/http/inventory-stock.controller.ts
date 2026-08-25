import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ReadStockOnHandUseCase } from '../../application/inventory/read-stock-on-hand.use-case';
import { SkipThrottle } from '@nestjs/throttler';
import { Access } from './access/access.decorator';
import { InventoryThrottlerGuard, OTHER_BUCKETS } from './inventory-throttling';
import { actorOf } from './principal.middleware';

interface StockLevelResponse {
  readonly sku: string;
  readonly location: string;
  readonly onHand: number;
}

/**
 * What is on hand, per product and place.
 *
 * A read, so a viewer reaches it. Machines too: an upstream system reconciling
 * its own figures against what the platform derived from what it sent is the
 * obvious use, and refusing it would mean the only caller that can write cannot
 * check its own work.
 */
@Controller('tenants/:tenantId/inventory/stock')
@UseGuards(InventoryThrottlerGuard)
@SkipThrottle(OTHER_BUCKETS)
export class InventoryStockController {
  constructor(private readonly stock: ReadStockOnHandUseCase) {}

  @Get()
  @Access({ roles: ['admin', 'editor', 'viewer'], machines: true })
  async index(@Req() request: Request): Promise<StockLevelResponse[]> {
    const levels = await this.stock.execute({ actor: actorOf(request) });

    return levels.map((level) => ({
      sku: level.sku,
      location: level.location,
      onHand: level.onHand,
    }));
  }
}
