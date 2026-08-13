import { Module } from '@nestjs/common';
import { PlatformPeopleController } from './adapters/http/platform-people.controller';
import { TenantMembersController } from './adapters/http/tenant-members.controller';
import { TenantsController } from './adapters/http/tenants.controller';
import { DrizzleModule } from './adapters/persistence/postgres/drizzle.module';
import { PostgresPlatformUnitOfWork } from './adapters/persistence/postgres/postgres-platform-unit-of-work';
import { PostgresTenantScopedUnitOfWork } from './adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import { SystemClock } from './adapters/system/system-clock';
import { UuidIdentifierGenerator } from './adapters/system/uuid-identifier-generator';
import { ChangeMemberRoleUseCase } from './application/membership/change-member-role.use-case';
import { CreateTenantMemberUseCase } from './application/membership/create-tenant-member.use-case';
import { ListTenantMembersUseCase } from './application/membership/list-tenant-members.use-case';
import { RevokeMembershipUseCase } from './application/membership/revoke-membership.use-case';
import { DeactivatePersonUseCase } from './application/person/deactivate-person.use-case';
import { CLOCK } from './application/ports/clock';
import { IDENTIFIER_GENERATOR } from './application/ports/identifier-generator';
import { PLATFORM_UNIT_OF_WORK } from './application/ports/platform-unit-of-work';
import { TENANT_SCOPED_UNIT_OF_WORK } from './application/ports/tenant-scoped-unit-of-work';
import { DeactivateTenantUseCase } from './application/tenant/deactivate-tenant.use-case';
import { ListTenantsUseCase } from './application/tenant/list-tenants.use-case';
import { ProvisionTenantUseCase } from './application/tenant/provision-tenant.use-case';

/**
 * Where the ports meet their adapters, and the only file that knows both names.
 *
 * Every binding is one line, which is the payoff for the boundary: the use
 * cases below are the same objects the unit tests build by hand with in-memory
 * doubles. Nothing here is imported by the application layer, so swapping an
 * adapter is a change to this file alone.
 */
@Module({
  imports: [DrizzleModule],
  controllers: [
    TenantsController,
    TenantMembersController,
    PlatformPeopleController,
  ],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: IDENTIFIER_GENERATOR, useClass: UuidIdentifierGenerator },
    {
      provide: TENANT_SCOPED_UNIT_OF_WORK,
      useClass: PostgresTenantScopedUnitOfWork,
    },
    { provide: PLATFORM_UNIT_OF_WORK, useClass: PostgresPlatformUnitOfWork },

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
