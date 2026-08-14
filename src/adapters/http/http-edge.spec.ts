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
import { JwtAccessTokenIssuer } from '../crypto/access-token-issuer';
import { RandomSecretGenerator } from '../crypto/random-secret-generator';
import { InMemoryApiKeyStore } from '../persistence/in-memory/in-memory-api-key-store';
import { InMemoryAuthenticatorUnitOfWork } from '../persistence/in-memory/in-memory-authenticator-unit-of-work';
import { PrincipalResolver } from '../../application/principal-resolver';
import { personId as toPersonId } from '../../domain/identifiers';
import { PrincipalMiddleware } from './principal.middleware';
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

  const tokens = new JwtAccessTokenIssuer({
    secret: 'a-signing-secret-long-enough-for-the-rule',
    accessTokenLifetimeSeconds: 900,
  });
  const OPERATOR_PERSON = '018f2c00-0000-7000-8000-0000000000aa';
  let operator: Record<string, string>;

  /**
   * Real credentials, not asserted headers. The tenant still comes from the
   * path — a token names a person and never a tenant — so `asMember` needs only
   * the person.
   */
  async function bearer(personId: string): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await tokens.issue(toPersonId(personId), new Date())}`,
    };
  }

  function asMember(_tenantId: string, personId: string) {
    return bearer(personId);
  }

  beforeEach(async () => {
    context = createIdentityTestContext();
    context.credentials.operators.add(toPersonId(OPERATOR_PERSON));
    operator = await bearer(OPERATOR_PERSON);

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
        {
          provide: PrincipalResolver,
          useValue: new PrincipalResolver(
            tokens,
            new InMemoryAuthenticatorUnitOfWork(
              context.credentials,
              new InMemoryApiKeyStore(),
            ),
            new RandomSecretGenerator(),
            { now: () => new Date() },
          ),
        },
        PrincipalMiddleware,
      ],
    })
    class EdgeTestModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(PrincipalMiddleware).forRoutes('*path');
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
        .set(await asMember(tenantId, admin))
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
        .set(await asMember(tenantId, admin))
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
        .set(await asMember(acme, acmeAdmin));
      const nowhere = await request(app.getHttpServer())
        .delete(`/tenants/${acme}/members/does-not-exist-anywhere`)
        .set(await asMember(acme, acmeAdmin));

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
        .set(await asMember(tenantId, viewer));
      const absent = await request(app.getHttpServer())
        .get('/tenants/no-such-tenant/members')
        .set(await asMember('no-such-tenant', viewer));

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
        .set(await asMember(tenantId, admin));

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
      const headers = await asMember(tenantId, admin);

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
        .set(await asMember(acme, acmeAdmin))
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
        .set(await asMember(tenantId, admin))
        .send({ name: 'Globex', administratorEmail: 'founder@example.com' });

      expect(operatorInside.status).toBe(404);
      expect(memberOutside.status).toBe(404);
    });

    it('refuses a request with no actor at all', async () => {
      const response = await request(app.getHttpServer()).get('/tenants');

      expect(response.status).toBe(404);
    });
  });

  describe('no request may assert its own principal', () => {
    it('ignores the headers the provisional middleware used to trust', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });

      const response = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set({
          'x-actor-kind': 'tenant-member',
          'x-tenant-id': tenantId,
          'x-person-id': admin,
        });

      expect(response.status).toBe(404);
    });

    it('refuses a token this platform did not sign', async () => {
      const forged = new JwtAccessTokenIssuer({
        secret: 'a-completely-different-secret-of-sufficient-size',
        accessTokenLifetimeSeconds: 900,
      });
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });

      const response = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set({
          authorization: `Bearer ${await forged.issue(toPersonId(admin), new Date())}`,
        });

      expect(response.status).toBe(404);
    });
  });
});
