import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { bearerFor, body, createApplication } from './support/application';
import { seed } from './support/database';
import { seedOperator, useIntegrationDatabase } from './support/fixtures';

/**
 * Being an operator is a fact in storage, consulted per request.
 *
 * The adapter suite proves the query reports it. These prove the boundary is
 * built on that query and on nothing else: not on a header, not on a claim
 * inside the token, and not on what was true when the token was issued.
 */
describe('the operator boundary', () => {
  useIntegrationDatabase();

  it('refuses a person who is not recorded as one, whatever the request says', async () => {
    const app = await application();
    const stranger = await aPerson('stranger@example.com');

    // A genuine token — the signature verifies — for someone the platform has
    // simply never recorded as an operator, sent with every claim a caller
    // could think to make.
    const response = await request(app.getHttpServer())
      .post('/tenants')
      .set(await bearerFor(stranger))
      .set({
        'x-actor-kind': 'platform-operator',
        'x-person-id': stranger,
        'x-platform-operator': 'true',
        'x-role': 'admin',
      })
      .send({ name: 'Theirs', administratorEmail: 'admin@theirs.example.com' });

    expect(response.status).toBe(404);
    expect(await tenantCount()).toBe(0);
  });

  it('stops accepting a token the moment operator status is withdrawn', async () => {
    const app = await application();
    const founder = await aPerson('founder@example.com');
    await seedOperator(founder);
    // Issued once and reused throughout: the token never changes, so anything
    // that changes must have come from storage.
    const headers = await bearerFor(founder);

    const allowed = await request(app.getHttpServer())
      .post('/tenants')
      .set(headers)
      .send({ name: 'Acme', administratorEmail: 'admin@acme.example.com' });
    expect(allowed.status).toBe(201);

    await seed((client) =>
      client.query('DELETE FROM platform_operators WHERE person_id = $1', [
        founder,
      ]),
    );

    const refused = await request(app.getHttpServer())
      .post('/tenants')
      .set(headers)
      .send({ name: 'Globex', administratorEmail: 'admin@globex.example.com' });
    expect(refused.status).toBe(404);
    expect(await tenantCount()).toBe(1);
  });

  it('stops accepting it when the operator themselves is deactivated', async () => {
    const app = await application();
    const founder = await aPerson('founder@example.com');
    await seedOperator(founder);
    const headers = await bearerFor(founder);

    // Still recorded as an operator, but no longer an active person. Either
    // fact alone must be enough to refuse.
    await seed((client) =>
      client.query("UPDATE people SET status = 'deactivated' WHERE id = $1", [
        founder,
      ]),
    );

    const refused = await request(app.getHttpServer())
      .post('/tenants')
      .set(headers)
      .send({ name: 'Acme', administratorEmail: 'admin@acme.example.com' });

    expect(refused.status).toBe(404);
    expect(await tenantCount()).toBe(0);
  });

  it('records which operator acted, and does not record it for anyone else', async () => {
    const app = await application();
    const founder = await aPerson('founder@example.com');
    const second = await aPerson('deputy@example.com');
    await seedOperator(founder);
    await seedOperator(second);

    const lines = await captureLog(async () => {
      await request(app.getHttpServer())
        .post('/tenants')
        .set(await bearerFor(founder))
        .send({ name: 'Acme', administratorEmail: 'admin@acme.example.com' });
      // The same action, refused: an attempt is as much a matter of record as
      // a success, and the name on it has to be right either way.
      await request(app.getHttpServer())
        .post('/tenants')
        .set(await bearerFor(second))
        .send({ name: 'Acme', administratorEmail: 'other@acme.example.com' });
    });

    const attributed = lines.filter((line) => line.includes('operator '));
    expect(attributed).toHaveLength(2);
    expect(attributed[0]).toContain(founder);
    expect(attributed[0]).toContain('succeeded');
    expect(attributed[1]).toContain(second);
    expect(attributed[1]).toContain('failed');
    // Two different people, two different records. One line naming "an
    // operator" would satisfy a weaker assertion and no audit.
    expect(attributed[1]).not.toContain(founder);
    expect(lines.join('\n')).not.toContain('founder@example.com');
  });

  it('leaves an operator no way in through the tenant routes', async () => {
    const app = await application();
    const founder = await aPerson('founder@example.com');
    await seedOperator(founder);
    const headers = await bearerFor(founder);

    const created = await request(app.getHttpServer())
      .post('/tenants')
      .set(headers)
      .send({ name: 'Acme', administratorEmail: 'admin@acme.example.com' });
    expect(created.status).toBe(201);
    const { id } = body<{ id: string }>(created);

    // Provisioning a tenant does not make its provisioner a member of it, and
    // operator status is not a spare membership.
    const inside = await request(app.getHttpServer())
      .get(`/tenants/${id}/members`)
      .set(headers);

    expect(inside.status).toBe(404);
  });

  async function aPerson(email: string): Promise<string> {
    const id = randomUUID();
    await seed((client) =>
      client.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
        id,
        email,
      ]),
    );
    return id;
  }

  async function tenantCount(): Promise<number> {
    return seed(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tenants',
      );
      return Number(rows[0].count);
    });
  }

  /** Collects what the application wrote while `work` ran. */
  async function captureLog(work: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const record = (message: unknown) => {
      lines.push(String(message));
    };
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(record),
    );
    try {
      await work();
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    return lines;
  }

  let shared: INestApplication<App> | undefined;

  async function application(): Promise<INestApplication<App>> {
    shared ??= await createApplication();
    return shared;
  }

  afterAll(async () => {
    await shared?.close();
  });
});
