import { Module } from '@nestjs/common';
import { PlatformPeopleController } from './adapters/http/platform-people.controller';
import { TenantMembersController } from './adapters/http/tenant-members.controller';
import { TenantsController } from './adapters/http/tenants.controller';
import { ChangeMemberRoleUseCase } from './application/membership/change-member-role.use-case';
import { CreateTenantMemberUseCase } from './application/membership/create-tenant-member.use-case';
import { ListTenantMembersUseCase } from './application/membership/list-tenant-members.use-case';
import { RevokeMembershipUseCase } from './application/membership/revoke-membership.use-case';
import { DeactivatePersonUseCase } from './application/person/deactivate-person.use-case';
import { DeactivateTenantUseCase } from './application/tenant/deactivate-tenant.use-case';
import { ListTenantsUseCase } from './application/tenant/list-tenants.use-case';
import { ProvisionTenantUseCase } from './application/tenant/provision-tenant.use-case';
import { PersistenceModule } from './persistence.module';

/**
 * Tenants, memberships and people: the routes and the use cases behind them.
 *
 * Every binding is one line, which is the payoff for the boundary: the use
 * cases below are the same objects the unit tests build by hand with in-memory
 * doubles. Nothing here is imported by the application layer, so swapping an
 * adapter is a change to `PersistenceModule` alone.
 */
@Module({
  imports: [PersistenceModule],
  controllers: [
    TenantsController,
    TenantMembersController,
    PlatformPeopleController,
  ],
  providers: [
    ProvisionTenantUseCase,
    ListTenantsUseCase,
    DeactivateTenantUseCase,
    CreateTenantMemberUseCase,
    ListTenantMembersUseCase,
    ChangeMemberRoleUseCase,
    RevokeMembershipUseCase,
    DeactivatePersonUseCase,
  ],
})
export class IdentityModule {}
