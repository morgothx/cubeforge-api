import { Module } from '@nestjs/common';
import { InventoryLocationsController } from './adapters/http/inventory-locations.controller';
import { InventoryProductsController } from './adapters/http/inventory-products.controller';
import { DeclareLocationUseCase } from './application/inventory/declare-location.use-case';
import { DeclareProductUseCase } from './application/inventory/declare-product.use-case';
import { ListLocationsUseCase } from './application/inventory/list-locations.use-case';
import { ListProductsUseCase } from './application/inventory/list-products.use-case';
import { PersistenceModule } from './persistence.module';

/**
 * The inventory surface: the first one on this platform built for machines
 * rather than for people.
 *
 * Nothing here is inventory-specific infrastructure. The repositories come from
 * `PersistenceModule` through the tenant-scoped seam, the guard and the
 * principal resolution are the platform's, and the only thing this feature
 * added to either was a second way to ask which tenant a caller acts in.
 */
@Module({
  imports: [PersistenceModule],
  controllers: [InventoryProductsController, InventoryLocationsController],
  providers: [
    DeclareProductUseCase,
    DeclareLocationUseCase,
    ListProductsUseCase,
    ListLocationsUseCase,
  ],
})
export class InventoryModule {}
