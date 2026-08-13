import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Response } from 'supertest';
import { AppModule } from '../../src/app.module';
import { configure } from '../../src/main';
import { asPersonInTenant, seed } from './support/database';
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

  let app: INestApplication<App>;

  const operator = {
    'x-actor-kind': 'platform-operator',
    'x-person-id': '018f2c00-0000-7000-8000-0000000000aa',
  };

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
      .set(operator)
      .send({ name: 'Acme', administratorEmail: 'admin-Acme@example.com' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Acme', status: 'active' });

    const listed = await request(app.getHttpServer())
      .get('/tenants')
      .set(operator);
    expect(body<unknown[]>(listed)).toHaveLength(1);
  });

  it('rejects an unknown field instead of quietly ignoring it', async () => {
    const response = await request(app.getHttpServer())
      .post('/tenants')
      .set(operator)
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
      .set(operator)
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
    const asAdmin = {
      'x-actor-kind': 'tenant-member',
      'x-tenant-id': tenant.id,
      'x-person-id': adminId,
    };

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
        .set(operator)
        .send({ name: 'Acme', administratorEmail: 'admin-Acme@example.com' }),
    );
    const globex = body<{ id: string }>(
      await request(app.getHttpServer()).post('/tenants').set(operator).send({
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
      .set({
        'x-actor-kind': 'tenant-member',
        'x-tenant-id': globex.id,
        'x-person-id': intruder,
      });

    expect(response.status).toBe(404);
  });

  it('refuses a request with no actor', async () => {
    const response = await request(app.getHttpServer()).get('/tenants');

    expect(response.status).toBe(404);
  });
});
