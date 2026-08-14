import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Response } from 'supertest';
import { AppModule } from '../../src/app.module';
import { configure } from '../../src/main';
import { asPersonInTenant, seed } from './support/database';
import { bearerFor, operatorHeaders } from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

function body<T>(response: Response): T {
  return response.body as T;
}

/**
 * The whole application, assembled exactly as `main.ts` assembles it, against
 * the local database. Everything below travels the real path: middleware,
 * validation pipe, controller, use case, Postgres adapter, row-level security,
 * error filter.
 *
 * This is the only suite that would notice a binding missing from
 * `IdentityModule`, a pipe that was never registered, or a filter that is not
 * global — none of which any narrower test can see.
 */
describe('the application, end to end', () => {
  useIntegrationDatabase();

  /**
   * Provisioning names an administrator but answers with the tenant, so the
   * only way to learn their identifier without a route is to read the row the
   * same way the tenant itself would.
   */
  async function administratorOf(tenantId: string): Promise<string> {
    return asPersonInTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ person_id: string }>(
        'SELECT person_id FROM memberships WHERE tenant_id = $1',
        [tenantId],
      );
      return rows[0].person_id;
    });
  }

  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('provisions a tenant and lists it back', async () => {
    const created = await request(app.getHttpServer())
      .post('/tenants')
      .set(await operatorHeaders())
      .send({ name: 'Acme', administratorEmail: 'admin-Acme@example.com' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Acme', status: 'active' });

    const listed = await request(app.getHttpServer())
      .get('/tenants')
      .set(await operatorHeaders());
    expect(body<unknown[]>(listed)).toHaveLength(1);
  });

  it('rejects an unknown field instead of quietly ignoring it', async () => {
    const response = await request(app.getHttpServer())
      .post('/tenants')
      .set(await operatorHeaders())
      .send({
        name: 'Acme',
        administratorEmail: 'a@example.com',
        status: 'active',
      });

    expect(response.status).toBe(400);
  });

  it('carries a member through creation, listing and revocation', async () => {
    const created = await request(app.getHttpServer())
      .post('/tenants')
      .set(await operatorHeaders())
      .send({ name: 'Acme', administratorEmail: 'admin-Acme@example.com' });
    const tenant = body<{ id: string }>(created);

    // No raw SQL any more: provisioning created the administrator. Their
    // identifier is read back through a privileged connection because the
    // response deliberately does not disclose it.
    const adminId = await seed(async (client) => {
      const { rows } = await client.query<{ person_id: string }>(
        'SELECT person_id FROM memberships WHERE tenant_id = $1',
        [tenant.id],
      );
      return rows[0].person_id;
    });
    const asAdmin = await bearerFor(adminId);

    const member = await request(app.getHttpServer())
      .post(`/tenants/${tenant.id}/members`)
      .set(asAdmin)
      .send({ email: 'newcomer@example.com', role: 'viewer' });
    expect(member.status).toBe(201);

    const listed = await request(app.getHttpServer())
      .get(`/tenants/${tenant.id}/members`)
      .set(asAdmin);
    expect(
      body<{ email: string }[]>(listed)
        .map((entry) => entry.email)
        .sort(),
    ).toEqual(['admin-acme@example.com', 'newcomer@example.com']);

    const revoked = await request(app.getHttpServer())
      .delete(
        `/tenants/${tenant.id}/members/${body<{ membershipId: string }>(member).membershipId}`,
      )
      .set(asAdmin);
    expect(revoked.status).toBe(204);

    const remaining = await request(app.getHttpServer())
      .get(`/tenants/${tenant.id}/members`)
      .set(asAdmin);
    expect(body<unknown[]>(remaining)).toHaveLength(1);
  });

  it('refuses a member of one tenant acting on another, as an absence', async () => {
    const acme = body<{ id: string }>(
      await request(app.getHttpServer())
        .post('/tenants')
        .set(await operatorHeaders())
        .send({ name: 'Acme', administratorEmail: 'admin-Acme@example.com' }),
    );
    const globex = body<{ id: string }>(
      await request(app.getHttpServer())
        .post('/tenants')
        .set(await operatorHeaders())
        .send({
          name: 'Globex',
          administratorEmail: 'admin-Globex@example.com',
        }),
    );

    const intruder = crypto.randomUUID();
    await asPersonInTenant(acme.id, async (client) => {
      await client.query(
        'SELECT find_or_create_person($1::uuid, $2::citext, now())',
        [intruder, 'admin@acme.example.com'],
      );
      await client.query(
        'INSERT INTO memberships (id, tenant_id, person_id, role) VALUES ($1, $2, $3, $4)',
        [crypto.randomUUID(), acme.id, intruder, 'admin'],
      );
    });

    const response = await request(app.getHttpServer())
      .get(`/tenants/${globex.id}/members`)
      .set(await bearerFor(intruder));

    expect(response.status).toBe(404);
  });

  /**
   * The whole credential story on the real stack: an operator hands out a setup
   * token, the holder turns it into a password, signs in with it, and the
   * access token that comes back is enough to act as an administrator — who
   * then issues an API key that authenticates in its own right.
   *
   * Nothing here is planted in the database. Every step goes through a route,
   * which is the only way to show that they connect.
   */
  it('carries a person from a setup token to a session, and a tenant to an API key', async () => {
    const tenant = body<{ id: string }>(
      await request(app.getHttpServer())
        .post('/tenants')
        .set(await operatorHeaders())
        .send({ name: 'Acme', administratorEmail: 'admin-Acme@example.com' }),
    );
    const [admin] = body<{ personId: string }[]>(
      await request(app.getHttpServer())
        .get(`/tenants/${tenant.id}/members`)
        .set(await bearerFor(await administratorOf(tenant.id))),
    );

    const issued = await request(app.getHttpServer())
      .post(`/platform/people/${admin.personId}/setup-tokens`)
      .set(await operatorHeaders());
    expect(issued.status).toBe(201);

    const redeemed = await request(app.getHttpServer())
      .post('/auth/credentials')
      .send({
        token: body<{ setupToken: string }>(issued).setupToken,
        password: 'correct horse battery staple',
      });
    expect(redeemed.status).toBe(204);

    const signedIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: 'admin-acme@example.com',
        password: 'correct horse battery staple',
      });
    expect(signedIn.status).toBe(200);
    const session = body<{ accessToken: string; refreshToken: string }>(
      signedIn,
    );
    const asAdmin = { authorization: `Bearer ${session.accessToken}` };

    const key = await request(app.getHttpServer())
      .post(`/tenants/${tenant.id}/api-keys`)
      .set(asAdmin)
      .send({ label: 'inventory sync', role: 'editor' });
    expect(key.status).toBe(201);
    const secret = body<{ secret: string }>(key).secret;

    // Used once as a machine credential — refused, because a machine is not a
    // member — and the listing shows that it nonetheless resolved.
    const asMachine = await request(app.getHttpServer())
      .get(`/tenants/${tenant.id}/members`)
      .set({ 'x-api-key': secret });
    expect(asMachine.status).toBe(404);

    const listed = await request(app.getHttpServer())
      .get(`/tenants/${tenant.id}/api-keys`)
      .set(asAdmin);
    const summaries = body<{ lastUsedAt: string | null }[]>(listed);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].lastUsedAt).not.toBeNull();
    expect(JSON.stringify(summaries)).not.toContain(secret);

    // A refresh token from the same session still works, and signing out ends it.
    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);

    const signedOut = await request(app.getHttpServer())
      .post('/auth/sign-out')
      .send({
        refreshToken: body<{ refreshToken: string }>(refreshed).refreshToken,
      });
    expect(signedOut.status).toBe(204);
  });

  it('refuses a request with no actor', async () => {
    const response = await request(app.getHttpServer()).get('/tenants');

    expect(response.status).toBe(404);
  });
});
