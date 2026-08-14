import {
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Response } from 'supertest';
import { IssueApiKeyUseCase } from '../../application/api-key/issue-api-key.use-case';
import { ListApiKeysUseCase } from '../../application/api-key/list-api-keys.use-case';
import { RevokeApiKeyUseCase } from '../../application/api-key/revoke-api-key.use-case';
import { RefreshSessionUseCase } from '../../application/authentication/refresh-session.use-case';
import { SignInUseCase } from '../../application/authentication/sign-in.use-case';
import { SignOutUseCase } from '../../application/authentication/sign-out.use-case';
import { IssueSetupTokenUseCase } from '../../application/credential/issue-setup-token.use-case';
import { RedeemSetupTokenUseCase } from '../../application/credential/redeem-setup-token.use-case';
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
import { Argon2PasswordHasher } from '../crypto/argon2-password-hasher';
import { JwtAccessTokenIssuer } from '../crypto/access-token-issuer';
import { RandomSecretGenerator } from '../crypto/random-secret-generator';
import { InMemoryAuthenticatorUnitOfWork } from '../persistence/in-memory/in-memory-authenticator-unit-of-work';
import { PrincipalResolver } from '../../application/principal-resolver';
import { personId as toPersonId } from '../../domain/identifiers';
import { CorrelationMiddleware } from './correlation.middleware';
import {
  CredentialThrottlerGuard,
  throttlerOptions,
} from './credential-throttling';
import { PrincipalMiddleware } from './principal.middleware';
import { ApiKeysController } from './api-keys.controller';
import { AuthenticationController } from './authentication.controller';
import { CredentialSetupController } from './credential-setup.controller';
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
  /** Argon2 at its cheapest: these tests are about routing, not about cost. */
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });
  const secrets = new RandomSecretGenerator();
  /**
   * Small enough that a test can exhaust a bucket in a few requests, and still
   * large enough that the tests which merely sign in once are unaffected.
   */
  const THROTTLING = {
    windowSeconds: 60,
    cooldownSeconds: 60,
    signInAttemptsPerAddress: 3,
    signInAttemptsPerOrigin: 8,
    redemptionsPerOrigin: 3,
  };
  const OPERATOR_PERSON = '018f2c00-0000-7000-8000-0000000000aa';
  let operator: Record<string, string>;

  /**
   * Real credentials, not asserted headers. The tenant still comes from the
   * path — a token names a person and never a tenant — so `asMember` needs only
   * the person.
   */
  async function bearer(personId: string): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await tokens.issue(toPersonId(personId), context.clock.now())}`,
    };
  }

  function asMember(_tenantId: string, personId: string) {
    return bearer(personId);
  }

  beforeEach(async () => {
    context = createIdentityTestContext();
    context.credentials.operators.add(toPersonId(OPERATOR_PERSON));
    operator = await bearer(OPERATOR_PERSON);
    const authenticator = new InMemoryAuthenticatorUnitOfWork(
      context.credentials,
      context.apiKeys,
    );

    @Module({
      imports: [ThrottlerModule.forRoot(throttlerOptions(THROTTLING))],
      controllers: [
        TenantsController,
        TenantMembersController,
        PlatformPeopleController,
        AuthenticationController,
        CredentialSetupController,
        ApiKeysController,
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
          provide: SignInUseCase,
          useValue: new SignInUseCase(
            authenticator,
            hasher,
            tokens,
            secrets,
            context.clock,
            context.identifiers,
          ),
        },
        {
          provide: RefreshSessionUseCase,
          useValue: new RefreshSessionUseCase(
            authenticator,
            tokens,
            secrets,
            context.clock,
            context.identifiers,
          ),
        },
        {
          provide: SignOutUseCase,
          useValue: new SignOutUseCase(authenticator, secrets, context.clock),
        },
        {
          provide: IssueSetupTokenUseCase,
          useValue: new IssueSetupTokenUseCase(
            context.platform,
            secrets,
            context.clock,
            context.identifiers,
          ),
        },
        {
          provide: RedeemSetupTokenUseCase,
          useValue: new RedeemSetupTokenUseCase(
            authenticator,
            hasher,
            context.clock,
            secrets,
          ),
        },
        {
          provide: IssueApiKeyUseCase,
          useValue: new IssueApiKeyUseCase(
            context.tenantScoped,
            secrets,
            context.clock,
            context.identifiers,
          ),
        },
        {
          provide: ListApiKeysUseCase,
          useValue: new ListApiKeysUseCase(context.tenantScoped),
        },
        {
          provide: RevokeApiKeyUseCase,
          useValue: new RevokeApiKeyUseCase(
            context.tenantScoped,
            context.clock,
          ),
        },
        {
          provide: PrincipalResolver,
          // The same key store the tenant-scoped unit of work writes to, so a
          // key issued through the route is a key that can then authenticate.
          useValue: new PrincipalResolver(
            tokens,
            authenticator,
            secrets,
            context.clock,
          ),
        },
        PrincipalMiddleware,
        CorrelationMiddleware,
        CredentialThrottlerGuard,
      ],
    })
    class EdgeTestModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer
          .apply(CorrelationMiddleware, PrincipalMiddleware)
          .forRoutes('*path');
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

  describe('the authentication routes', () => {
    const PASSWORD = 'correct horse battery staple';

    /**
     * Through the routes and nothing else: an operator issues a setup token,
     * the holder redeems it, and only then is there a password to sign in with.
     * A test that reached into the credential store to plant one would prove
     * the routes reachable without proving them connected.
     */
    async function aPersonWithAPassword(email: string): Promise<{
      tenantId: string;
      personId: string;
    }> {
      const tenantId = await context.seedTenant('Acme');
      const personId = await context.seedMember({
        tenantId,
        email,
        role: 'admin',
      });

      const issued = await request(app.getHttpServer())
        .post(`/platform/people/${personId}/setup-tokens`)
        .set(operator);
      expect(issued.status).toBe(201);

      const redeemed = await request(app.getHttpServer())
        .post('/auth/credentials')
        .send({
          token: body<{ setupToken: string }>(issued).setupToken,
          password: PASSWORD,
        });
      expect(redeemed.status).toBe(204);

      return { tenantId, personId };
    }

    it('carries a person from a setup token to a working session', async () => {
      const { tenantId, personId } =
        await aPersonWithAPassword('admin@example.com');

      const signedIn = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'admin@example.com', password: PASSWORD });

      expect(signedIn.status).toBe(200);
      const session = body<{
        accessToken: string;
        refreshToken: string;
        sessionExpiresAt: string;
      }>(signedIn);
      expect(Object.keys(session).sort()).toEqual([
        'accessToken',
        'refreshToken',
        'sessionExpiresAt',
      ]);

      // The token the route just issued is a credential the platform accepts.
      const acting = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set({ authorization: `Bearer ${session.accessToken}` });
      expect(acting.status).toBe(200);
      expect(body<{ personId: string }[]>(acting)[0].personId).toBe(personId);
    });

    it('rotates a refresh token and refuses the one it replaced', async () => {
      await aPersonWithAPassword('admin@example.com');
      const signedIn = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'admin@example.com', password: PASSWORD });
      const first = body<{ refreshToken: string }>(signedIn).refreshToken;

      const refreshed = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: first });
      expect(refreshed.status).toBe(200);
      expect(body<{ refreshToken: string }>(refreshed).refreshToken).not.toBe(
        first,
      );

      const replayed = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: first });
      expect(replayed.status).toBe(404);
    });

    it('ends a session, after which its refresh token buys nothing', async () => {
      await aPersonWithAPassword('admin@example.com');
      const signedIn = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'admin@example.com', password: PASSWORD });
      const refreshToken = body<{ refreshToken: string }>(
        signedIn,
      ).refreshToken;

      const signedOut = await request(app.getHttpServer())
        .post('/auth/sign-out')
        .send({ refreshToken });
      expect(signedOut.status).toBe(204);

      const afterwards = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken });
      expect(afterwards.status).toBe(404);
    });

    /**
     * Requirement 9.2 at the edge. A 400 for a malformed address would be a
     * reliable oracle — it says the guess was never going to match — so the
     * shape rules here stop short of judging the address.
     */
    it('answers a malformed address exactly as it answers an unknown one', async () => {
      const malformed = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'not-an-address', password: PASSWORD });
      const unknown = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'stranger@example.com', password: PASSWORD });

      expect(malformed.status).toBe(404);
      expect(malformed.body).toEqual(unknown.body);
    });

    it("reports a password below the policy, which is the holder's to fix", async () => {
      const tenantId = await context.seedTenant('Acme');
      const personId = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });
      const issued = await request(app.getHttpServer())
        .post(`/platform/people/${personId}/setup-tokens`)
        .set(operator);

      const response = await request(app.getHttpServer())
        .post('/auth/credentials')
        .send({
          token: body<{ setupToken: string }>(issued).setupToken,
          password: 'short',
        });

      expect(response.status).toBe(400);
      // The token survives a mistyped password: nothing was redeemed.
      expect(
        [...context.credentials.setupTokens.values()][0].redeemedAt,
      ).toBeNull();
    });

    it('refuses a setup token to anyone who is not an operator', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });

      const response = await request(app.getHttpServer())
        .post(`/platform/people/${admin}/setup-tokens`)
        .set(await asMember(tenantId, admin));

      expect(response.status).toBe(404);
      expect(context.credentials.setupTokens.size).toBe(0);
    });

    it('rejects a malformed payload before any use case runs', async () => {
      const missing = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'admin@example.com' });
      const extra = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'a-token', everywhere: true });
      const blank = await request(app.getHttpServer())
        .post('/auth/sign-out')
        .send({ refreshToken: '   ' });

      expect([missing.status, extra.status, blank.status]).toEqual([
        400, 400, 400,
      ]);
      expect(context.credentials.refreshTokens.size).toBe(0);
    });
  });

  describe('the API key routes', () => {
    async function anAdministrator(): Promise<{
      tenantId: string;
      headers: Record<string, string>;
    }> {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });
      return { tenantId, headers: await asMember(tenantId, admin) };
    }

    it('shows a secret once, at issuance, and never again', async () => {
      const { tenantId, headers } = await anAdministrator();

      const issued = await request(app.getHttpServer())
        .post(`/tenants/${tenantId}/api-keys`)
        .set(headers)
        .send({ label: 'inventory sync', role: 'editor' });
      expect(issued.status).toBe(201);
      const key = body<{ id: string; secret: string }>(issued);
      expect(Object.keys(key).sort()).toEqual(['id', 'secret']);

      const listed = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/api-keys`)
        .set(headers);
      expect(listed.status).toBe(200);
      const summaries = body<Record<string, unknown>[]>(listed);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        id: key.id,
        label: 'inventory sync',
        role: 'editor',
        lastUsedAt: null,
        revokedAt: null,
      });
      expect(JSON.stringify(summaries)).not.toContain(key.secret);
    });

    it('issues a key that then acts for its tenant, and stops when revoked', async () => {
      const { tenantId, headers } = await anAdministrator();
      const issued = await request(app.getHttpServer())
        .post(`/tenants/${tenantId}/api-keys`)
        .set(headers)
        .send({ label: 'inventory sync', role: 'editor' });
      const key = body<{ id: string; secret: string }>(issued);

      // A machine principal is not a member, so both the member routes and
      // these ones refuse it — while the key still resolved, which the recorded
      // moment of use proves.
      const asMachine = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/members`)
        .set({ 'x-api-key': key.secret });
      const managingKeys = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/api-keys`)
        .set({ 'x-api-key': key.secret });
      expect([asMachine.status, managingKeys.status]).toEqual([404, 404]);
      const afterUse = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/api-keys`)
        .set(headers);
      expect(
        body<{ lastUsedAt: string | null }[]>(afterUse)[0].lastUsedAt,
      ).not.toBeNull();

      const revoked = await request(app.getHttpServer())
        .delete(`/tenants/${tenantId}/api-keys/${key.id}`)
        .set(headers);
      expect(revoked.status).toBe(204);

      const afterRevocation = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/api-keys`)
        .set(headers);
      expect(
        body<{ revokedAt: string | null }[]>(afterRevocation)[0].revokedAt,
      ).not.toBeNull();
    });

    it("refuses an administrator who addresses another tenant's keys", async () => {
      const { headers } = await anAdministrator();
      const globex = await context.seedTenant('Globex');

      const response = await request(app.getHttpServer())
        .post(`/tenants/${globex}/api-keys`)
        .set(headers)
        .send({ label: 'theirs', role: 'viewer' });

      expect(response.status).toBe(404);
    });

    it('refuses a member who is not an administrator', async () => {
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

      const response = await request(app.getHttpServer())
        .get(`/tenants/${tenantId}/api-keys`)
        .set(await asMember(tenantId, viewer));

      expect(response.status).toBe(404);
    });
  });

  describe('resistance to guessing', () => {
    const PASSWORD = 'correct horse battery staple';

    async function attemptSignIn(email: string) {
      return request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password: 'not the password' });
    }

    async function exhaust(email: string): Promise<Response> {
      let last!: Response;
      for (
        let attempt = 0;
        attempt <= THROTTLING.signInAttemptsPerAddress;
        attempt += 1
      ) {
        last = await attemptSignIn(email);
      }
      return last;
    }

    it('refuses further attempts once an address has been guessed at enough', async () => {
      for (
        let attempt = 0;
        attempt < THROTTLING.signInAttemptsPerAddress;
        attempt += 1
      ) {
        expect((await attemptSignIn('member@example.com')).status).toBe(404);
      }

      const throttled = await attemptSignIn('member@example.com');
      expect(throttled.status).toBe(429);
    });

    /**
     * The two buckets are what make this survivable: without a per-address
     * count, one guesser exhausts the origin and everyone behind that address
     * is locked out; without a per-origin count, spraying one password across
     * many addresses is never counted at all.
     */
    it('counts each address separately, so guessing one does not lock out another', async () => {
      await exhaust('victim@example.com');

      const other = await attemptSignIn('bystander@example.com');

      expect(other.status).toBe(404);
    });

    it('counts the origin too, so spraying many addresses is still bounded', async () => {
      for (
        let attempt = 0;
        attempt < THROTTLING.signInAttemptsPerOrigin;
        attempt += 1
      ) {
        // A different address every time, so no address bucket comes close.
        const response = await attemptSignIn(`person-${attempt}@example.com`);
        expect(response.status).toBe(404);
      }

      const sprayed = await attemptSignIn('one-more@example.com');
      expect(sprayed.status).toBe(429);
    });

    /**
     * Requirement 9.4. Being throttled is the one thing a caller may learn, and
     * it must not become a way to learn a second thing — so the refusal for an
     * address that exists and one that does not has to be the same refusal.
     */
    it('answers a throttled known address exactly as a throttled unknown one', async () => {
      const tenantId = await context.seedTenant('Acme');
      const person = await context.seedMember({
        tenantId,
        email: 'known@example.com',
        role: 'admin',
      });
      context.credentials.passwords.set(person, {
        digest: await hasher.hash(PASSWORD),
        updatedAt: context.clock.now(),
      });

      const known = await exhaust('known@example.com');
      const unknown = await exhaust('unknown@example.com');

      expect(known.status).toBe(429);
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);
    });

    /** Requirement 9.2: the count costs the caller time, never the account. */
    it('leaves the account alone, and the password with it', async () => {
      const tenantId = await context.seedTenant('Acme');
      const person = await context.seedMember({
        tenantId,
        email: 'known@example.com',
        role: 'admin',
      });
      const digest = await hasher.hash(PASSWORD);
      context.credentials.passwords.set(person, {
        digest,
        updatedAt: context.clock.now(),
      });

      await exhaust('known@example.com');

      expect(context.store.people.get(person)?.status).toBe('active');
      expect(context.credentials.passwords.get(person)?.digest).toBe(digest);
    });

    it('counts redemptions by origin, since a setup token names nobody', async () => {
      for (
        let attempt = 0;
        attempt < THROTTLING.redemptionsPerOrigin;
        attempt += 1
      ) {
        const response = await request(app.getHttpServer())
          .post('/auth/credentials')
          .send({ token: 'an-invented-token', password: PASSWORD });
        expect(response.status).toBe(404);
      }

      const throttled = await request(app.getHttpServer())
        .post('/auth/credentials')
        .send({ token: 'an-invented-token', password: PASSWORD });
      expect(throttled.status).toBe(429);
    });

    /**
     * The buckets are separate, so exhausting one operation does not lock a
     * caller out of the other — which is why redemption has its own name rather
     * than sharing the sign-in origin count.
     */
    it('does not let exhausted redemptions close the sign-in route', async () => {
      for (
        let attempt = 0;
        attempt <= THROTTLING.redemptionsPerOrigin;
        attempt += 1
      ) {
        await request(app.getHttpServer())
          .post('/auth/credentials')
          .send({ token: 'an-invented-token', password: PASSWORD });
      }

      const signIn = await attemptSignIn('member@example.com');
      expect(signIn.status).toBe(404);
    });
  });

  describe('what is recorded, and what is not', () => {
    let logged: string[];

    beforeEach(() => {
      logged = [];
      jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('echoes a correlation identifier and logs the cause against it', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'stranger@example.com', password: 'not the password' });

      const correlationId = response.headers['x-correlation-id'];
      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(logged.some((line) => line.startsWith(correlationId))).toBe(true);
      // The cause is in the log and in nothing else (12.2).
      expect(logged.join('\n')).toContain('no credential for this address');
      expect(JSON.stringify(response.body)).not.toContain('credential');
      expect(JSON.stringify(response.body)).not.toContain(correlationId);
    });

    it('continues a trace the caller started, and refuses an unusable one', async () => {
      const continued = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .set({ 'x-correlation-id': 'trace-0123456789' })
        .send({ email: 'stranger@example.com', password: 'x' });
      const rejected = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .set({ 'x-correlation-id': 'a bad\tone' })
        .send({ email: 'stranger@example.com', password: 'x' });

      expect(continued.headers['x-correlation-id']).toBe('trace-0123456789');
      expect(rejected.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    /** Requirement 12.1, asserted over everything the request caused to be written. */
    it('writes no password, token or key secret to the log', async () => {
      const tenantId = await context.seedTenant('Acme');
      const admin = await context.seedMember({
        tenantId,
        email: 'admin@example.com',
        role: 'admin',
      });
      const headers = await asMember(tenantId, admin);
      const password = 'a-password-that-would-be-obvious-in-a-log';

      const personId = await context.seedMember({
        tenantId,
        email: 'newcomer@example.com',
        role: 'viewer',
      });
      const issued = await request(app.getHttpServer())
        .post(`/platform/people/${personId}/setup-tokens`)
        .set(operator);
      const setupToken = body<{ setupToken: string }>(issued).setupToken;

      await request(app.getHttpServer())
        .post('/auth/credentials')
        .send({ token: setupToken, password });
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'newcomer@example.com', password });
      const key = await request(app.getHttpServer())
        .post(`/tenants/${tenantId}/api-keys`)
        .set(headers)
        .send({ label: 'inventory sync', role: 'editor' });
      const secret = body<{ secret: string }>(key).secret;

      // A failure of each kind, so the log has something to say.
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: 'newcomer@example.com', password: 'wrong' });
      await request(app.getHttpServer())
        .post('/auth/credentials')
        .send({ token: setupToken, password });

      const everything = logged.join('\n');
      expect(everything.length).toBeGreaterThan(0);
      for (const secretValue of [password, setupToken, secret]) {
        expect(everything).not.toContain(secretValue);
      }
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
