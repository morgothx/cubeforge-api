import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  addMember,
  body,
  createApplication,
  seedTenantWithAdministrator,
} from './support/application';
import { seed } from './support/database';
import { seedCredential, useIntegrationDatabase } from './support/fixtures';

interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * What ending a session actually ends, against the storage that records it.
 *
 * Two of these assertions are about revocation working, and the third is about
 * the seam it leaves: an access token already in someone's hands stays usable
 * until it expires. That is the stated cost of not checking storage on every
 * request, and pinning it here means a future change that closes the seam has
 * to say so deliberately rather than discover it in production.
 */
describe('session revocation', () => {
  useIntegrationDatabase();

  const PASSWORD = 'correct horse battery staple';

  it('ends the whole family when an exchanged refresh token is presented again', async () => {
    const app = await application();
    const person = await personWithPassword('holder@acme.example.com');

    const first = await signIn(app, person.email);
    const second = await exchange(app, first.refreshToken);

    // The replay. Whoever sends it is either the legitimate holder whose token
    // was stolen, or the thief; there is no way to tell, so both lose the
    // session.
    expect((await refresh(app, first.refreshToken)).status).toBe(404);

    expect((await refresh(app, second.refreshToken)).status).toBe(404);
    expect(await liveTokensFor(person.personId)).toBe(0);
  });

  it('leaves other sign-ins of the same person untouched by one family ending', async () => {
    const app = await application();
    const person = await personWithPassword('holder@acme.example.com');

    const laptop = await signIn(app, person.email);
    const phone = await signIn(app, person.email);
    const rotated = await exchange(app, laptop.refreshToken);

    expect((await refresh(app, laptop.refreshToken)).status).toBe(404);
    expect((await refresh(app, rotated.refreshToken)).status).toBe(404);

    // A family is one sign-in, not one person. Ending every session on a replay
    // would turn a stolen token into a way to sign someone out of everything.
    expect((await refresh(app, phone.refreshToken)).status).toBe(200);
  });

  it('accepts no refresh token at all after signing out everywhere', async () => {
    const app = await application();
    const person = await personWithPassword('holder@acme.example.com');

    const laptop = await signIn(app, person.email);
    const phone = await signIn(app, person.email);

    const out = await request(app.getHttpServer())
      .post('/auth/sign-out')
      .send({ refreshToken: laptop.refreshToken, everywhere: true });
    expect(out.status).toBe(204);

    expect((await refresh(app, laptop.refreshToken)).status).toBe(404);
    expect((await refresh(app, phone.refreshToken)).status).toBe(404);
    expect(await liveTokensFor(person.personId)).toBe(0);
  });

  it('keeps an already-issued access token working until it expires', async () => {
    const app = await application();
    const tenant = await seedTenantWithAdministrator(app, 'Acme');
    const administrator = await addMember(
      app,
      tenant,
      'second-admin@acme.example.com',
      'admin',
    );
    await seedCredential(administrator.personId, PASSWORD);

    const session = await signIn(app, 'second-admin@acme.example.com');
    const out = await request(app.getHttpServer())
      .post('/auth/sign-out')
      .send({ refreshToken: session.refreshToken, everywhere: true });
    expect(out.status).toBe(204);

    const listed = await request(app.getHttpServer())
      .get(`/tenants/${tenant.id}/members`)
      .set({ authorization: `Bearer ${session.accessToken}` });

    // Not a defect: the access token is verified by signature and expiry alone,
    // which is what keeps ordinary requests off the credential tables. The
    // window is bounded by AUTH_ACCESS_TOKEN_SECONDS, and refreshing is what
    // revocation actually stops.
    expect(listed.status).toBe(200);
    expect((await refresh(app, session.refreshToken)).status).toBe(404);
  });

  /** Counted through the one identity allowed to see them. */
  async function liveTokensFor(personId: string): Promise<number> {
    return seed(async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM refresh_tokens
          WHERE person_id = $1 AND exchanged_at IS NULL AND invalidated_at IS NULL`,
        [personId],
      );
      return Number(rows[0].count);
    });
  }

  async function personWithPassword(
    email: string,
  ): Promise<{ personId: string; email: string }> {
    const app = await application();
    const tenant = await seedTenantWithAdministrator(app, 'Acme');
    const member = await addMember(app, tenant, email, 'viewer');
    await seedCredential(member.personId, PASSWORD);
    return { personId: member.personId, email };
  }

  async function signIn(
    app: INestApplication<App>,
    email: string,
  ): Promise<Session> {
    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return body<Session>(response);
  }

  async function exchange(
    app: INestApplication<App>,
    refreshToken: string,
  ): Promise<Session> {
    const response = await refresh(app, refreshToken);
    expect(response.status).toBe(200);
    return body<Session>(response);
  }

  function refresh(
    app: INestApplication<App>,
    refreshToken: string,
  ): Promise<Response> {
    return request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken });
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
