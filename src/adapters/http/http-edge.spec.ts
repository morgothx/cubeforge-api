import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Response } from 'supertest';
import { ChangeMemberRoleUseCase } from '../../application/membership/change-member-role.use-case';
import { CreateTenantMemberUseCase } from '../../application/membership/create-tenant-member.use-case';
import { ListTenantMembersUseCase } from '../../application/membership/list-tenant-members.use-case';
import { RevokeMembershipUseCase } from '../../application/membership/revoke-membership.use-case';
import { DeactivatePersonUseCase } from '../../application/person/deactivate-person.use-case';
import { DeactivateTenantUseCase } from '../../application/tenant/deactivate-tenant.use-case';
import { ListTenantsUseCase } from '../../application/tenant/list-tenants.use-case';
import { ProvisionTenantUseCase } from '../../application/tenant/provision-tenant.use-case';
import { tenantId } from '../../domain/identifiers';
import { createIdentityTestContext } from '../testing/identity-test-context';
import type { IdentityTestContext } from '../testing/identity-test-context';
import { createActorContextMiddleware } from './actor-context.middleware';
import { DomainErrorFilter } from './domain-error.filter';
import { PlatformPeopleController } from './platform-people.controller';
import { TenantMembersController } from './tenant-members.controller';
import { TenantsController } from './tenants.controller';

/**
 * Supertest types `body` as `any`, which the strict rules reject. Naming the
 * expected shape once per read keeps the assertions honest about what the
 * contract is supposed to be.
 */
function body<T>(response: Response): T {
  return response.body as T;
}

describe('the HTTP edge', () => {
  let app: INestApplication<App>;
  let context: IdentityTestContext;

  // An operator is a person now, so the provisional headers must name one.
  const operator = {
    'x-actor-kind': 'platform-operator',
    'x-person-id': '018f2c00-0000-7000-8000-0000000000aa',
  };

  function asMember(tenantId: string, personId: string) {
    return {
      'x-actor-kind': 'tenant-member',
      'x-tenant-id': tenantId,
      'x-person-id': personId,
    };
  }

  beforeEach(async () => {
    context = createIdentityTestContext();

    @Module({
      controllers: [
        TenantsController,
        TenantMembersController,
        PlatformPeopleController,
      ],
      providers: [
        {
          provide: ProvisionTenantUseCase,
          useValue: new ProvisionTenantUseCase(
            context.platform,
            context.tenantScoped,
            context.clock,
            context.identifiers,
          ),
        },
        {
          provide: ListTenantsUseCase,
          useValue: new ListTenantsUseCase(context.platform),
        },
        {
          provide: DeactivateTenantUseCase,
          useValue: new DeactivateTenantUseCase(context.platform),
        },
        {
          provide: DeactivatePersonUseCase,
          useValue: new DeactivatePersonUseCase(context.platform),
        },
        {
          provide: CreateTenantMemberUseCase,
          useValue: new CreateTenantMemberUseCase(
            context.tenantScoped,
            context.clock,
            context.identifiers,
          ),
        },
        {
          provide: ListTenantMembersUseCase,
          useValue: new ListTenantMembersUseCase(context.tenantScoped),
        },
        {
          provide: ChangeMemberRoleUseCase,
          useValue: new ChangeMemberRoleUseCase(context.tenantScoped),
        },
        {
          provide: RevokeMembershipUseCase,
          useValue: new RevokeMembershipUseCase(context.tenantScoped),
        },
      ],
    })
    class EdgeTestModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(createActorContextMiddleware('test')).forRoutes('*path');
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [EdgeTestModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('validation, before any use case runs', () => {
    it('rejects a blank tenant name', async () => {
      const response = await request(app.getHttpServer())
        .post('/tenants')
        .set(operator)
        .send({ name: '', administratorEmail: 'founder@example.com' });

      expect(response.status).toBe(400);
      expect(context.store.tenants.size).toBe(0);
    });

    it('rejects a role outside the permitted set, reporting them', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });

      const response = await request(app.getHttpServer())
        .post(`/tenants/${tenantId}/members`)
        .set(asMember(tenantId, admin))
        .send({ email: 'newcomer@example.com', role: 'superuser' });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('admin, editor, viewer');
      expect(context.store.memberships.size).toBe(1);
    });

    it('rejects a malformed email address', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });

      const response = await request(app.getHttpServer())
        .post(`/tenants/${tenantId}/members`)
        .set(asMember(tenantId, admin))
        .send({ email: 'not-an-address', role: 'viewer' });

      expect(response.status).toBe(400);
      expect(context.store.people.size).toBe(1);
    });
  });

  describe('error mapping', () => {
    /** Requirement 9.2, at the only level where it is observable. */
    it('answers identically for a record in another tenant and one that exists nowhere', async () => {
      const acme = await context.seedTenant('Acme');
      const globex = await context.seedTenant('Globex');
      const acmeAdmin = await context.seedMember({
        tenantId: acme,
        email: 'admin@acme.example.com',
        role: 'admin',
      });
      const outsider = await context.seedMember({
        tenantId: globex,
        email: 'outsider@example.com',
        role: 'viewer',
      });
      const foreign = [...context.store.memberships.values()].find(
        (membership) => membership.personId === outsider,
      );

      const elsewhere = await request(app.getHttpServer())
        .delete(`/tenants/${acme}/members/${foreign!.id}`)
        .set(asMember(acme, acmeAdmin));
      const nowhere = await request(app.getHttpServer())
        .delete(`/tenants/${acme}/members/does-not-exist-anywhere`)
        .set(asMember(acme, acmeAdmin));

      expect(elsewhere.status).toBe(404);
      expect(elsewhere.status).toBe(nowhere.status);
      expect(elsewhere.body).toEqual(nowhere.body);
    });

    it('answers the same way to a denial as to an absence', async () => {
      const tenantId = await context.seedTenant('Acme');
      await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });
      const viewer = await context.seedMember({
        tenantId,
        email: 'viewer@example.com',
        role: 'viewer',
      });

      const denied = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set(asMember(tenantId, viewer));
      const absent = await request(app.getHttpServer())
        .get('/tenants/no-such-tenant/members')
        .set(asMember('no-such-tenant', viewer));

      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(absent.body);
    });

    it('reports a duplicate tenant name as a conflict, naming the field', async () => {
      await request(app.getHttpServer())
        .post('/tenants')
        .set(operator)
        .send({ name: 'Acme', administratorEmail: 'founder@example.com' });

      const response = await request(app.getHttpServer())
        .post('/tenants')
        .set(operator)
        .send({ name: 'Acme', administratorEmail: 'founder@example.com' });

      expect(response.status).toBe(409);
      expect(body<{ field: string }>(response).field).toBe('name');
    });

    it('reports the last-administrator rule as a conflict', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });
      const membership = [...context.store.memberships.values()][0];

      const response = await request(app.getHttpServer())
        .delete(`/tenants/${tenantId}/members/${membership.id}`)
        .set(asMember(tenantId, admin));

      expect(response.status).toBe(409);
    });
  });

  describe('the routes themselves', () => {
    it('provisions, lists and deactivates a tenant', async () => {
      const created = await request(app.getHttpServer())
        .post('/tenants')
        .set(operator)
        .send({ name: 'Acme', administratorEmail: 'founder@example.com' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Acme', status: 'active' });
      const tenant = body<{ id: string }>(created);

      const listed = await request(app.getHttpServer())
        .get('/tenants')
        .set(operator);
      expect(body<unknown[]>(listed)).toHaveLength(1);

      const deactivated = await request(app.getHttpServer())
        .delete(`/tenants/${tenant.id}`)
        .set(operator);
      expect(deactivated.status).toBe(204);
      expect(context.store.tenants.get(tenantId(tenant.id))?.status).toBe(
        'inactive',
      );
    });

    it('creates, lists, re-roles and revokes a member', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });
      const headers = asMember(tenantId, admin);

      const created = await request(app.getHttpServer())
        .post(`/tenants/${tenantId}/members`)
        .set(headers)
        .send({ email: 'newcomer@example.com', role: 'viewer' });
      expect(created.status).toBe(201);
      const member = body<{ membershipId: string }>(created);
      expect(Object.keys(member).sort()).toEqual([
        'membershipId',
        'personId',
        'role',
      ]);

      const listed = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set(headers);
      const members = body<{ active: boolean }[]>(listed);
      expect(members).toHaveLength(2);
      expect(members.every((entry) => entry.active)).toBe(true);

      const rerole = await request(app.getHttpServer())
        .patch(`/tenants/${tenantId}/members/${member.membershipId}`)
        .set(headers)
        .send({ role: 'editor' });
      expect(rerole.status).toBe(204);

      const revoked = await request(app.getHttpServer())
        .delete(`/tenants/${tenantId}/members/${member.membershipId}`)
        .set(headers);
      expect(revoked.status).toBe(204);

      const remaining = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set(headers);
      expect(body<unknown[]>(remaining)).toHaveLength(1);
    });

    it('deactivates a person platform-wide', async () => {
      const tenantId = await context.seedTenant('Acme');
      const person = await context.seedMember({
        tenantId,
        email: 'member@example.com',
        role: 'viewer',
      });

      const response = await request(app.getHttpServer())
        .delete(`/platform/people/${person}`)
        .set(operator);

      expect(response.status).toBe(204);
      expect(context.store.people.get(person)?.status).toBe('deactivated');
    });

    it('refuses a tenant member who addresses another tenant by URL', async () => {
      const acme = await context.seedTenant('Acme');
      const globex = await context.seedTenant('Globex');
      const acmeAdmin = await context.seedMember({
        tenantId: acme,
        email: 'admin@acme.example.com',
        role: 'admin',
      });

      const response = await request(app.getHttpServer())
        .post(`/tenants/${globex}/members`)
        .set(asMember(acme, acmeAdmin))
        .send({ email: 'newcomer@example.com', role: 'viewer' });

      expect(response.status).toBe(404);
      expect(context.store.memberships.size).toBe(1);
    });

    it('refuses an operator on tenant-member routes and a member on operator routes', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });

      const operatorInside = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set(operator);
      const memberOutside = await request(app.getHttpServer())
        .post('/tenants')
        .set(asMember(tenantId, admin))
        .send({ name: 'Globex', administratorEmail: 'founder@example.com' });

      expect(operatorInside.status).toBe(404);
      expect(memberOutside.status).toBe(404);
    });

    it('refuses a request with no actor at all', async () => {
      const response = await request(app.getHttpServer()).get('/tenants');

      expect(response.status).toBe(404);
    });
  });

  describe('the provisional actor middleware', () => {
    it('refuses to be built in production', () => {
      expect(() => createActorContextMiddleware('production')).toThrow(
        /never be registered in production/,
      );
    });
  });
});
