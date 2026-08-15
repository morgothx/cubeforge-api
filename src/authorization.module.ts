import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AccessGuard } from './adapters/http/access/access.guard';
import { RouteInventory } from './adapters/http/access/route-inventory';
import { PersistenceModule } from './persistence.module';

/**
 * Turns the route declarations into enforcement.
 *
 * The guard is bound with `APP_GUARD` rather than applied per controller, and
 * that is the entire point of the feature: a route nobody thought about is
 * covered by the same rule as a route everybody reviewed. Applied per
 * controller, it would protect exactly the routes someone remembered to protect,
 * which is the state this feature exists to leave behind.
 *
 * `PersistenceModule` because the guard resolves a membership in a transaction
 * of its own. No use case learns anything from this module: enforcement arrives
 * in front of them, and the check each of them already performs stays exactly
 * where it was.
 */
@Module({
  imports: [PersistenceModule, DiscoveryModule],
  providers: [
    { provide: APP_GUARD, useClass: AccessGuard },
    // Not on any request path. It exists so the suites can ask the application
    // which routes it serves and what each one declares, which is what makes an
    // undeclared route detectable before someone calls it.
    RouteInventory,
  ],
  exports: [RouteInventory],
})
export class AuthorizationModule {}
