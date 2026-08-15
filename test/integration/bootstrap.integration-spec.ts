import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { bootstrapOperator } from '../../scripts/bootstrap-operator';
import { body, createApplication } from './support/application';
import { databaseConfig } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';

interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * From an empty database to a working tenant, with one privileged act and no
 * SQL of the harness's own.
 *
 * Everything else in this suite arranges its principals with fixtures, which is
 * right — a test about revoking API keys should not spend two Argon2 hashes
 * proving that sign-in works. This one is about exactly that: whether the
 * platform can be entered at all by the means it ships with. Until now it could
 * not. `grant-operator` refuses an address it cannot find, no route creates a
 * person without an operator, and no operator can obtain a password without
 * another operator issuing them a setup token — a closed circle that earlier
 * smoke runs only escaped by minting a token out of band.
 */
describe('the bootstrap path', () => {
  useIntegrationDatabase();

  const FOUNDER = 'founder@example.com';
  const FOUNDER_PASSWORD = 'correct horse battery staple';
  const ADMINISTRATOR = 'admin@acme.example.com';
  const ADMINISTRATOR_PASSWORD = 'a passphrase of theirs entirely';

  it('walks from nothing to a member added by an administrator', async () => {
    // The one privileged act, run as the migration identity — the same
    // authority that owns the schema, which is where requirement 11.5 puts the
    // root of trust. Everything after this is an HTTP request.
    const bootstrapped = await withMigrator((client) =>
      bootstrapOperator(client, FOUNDER, new Date()),
    );
    expect(bootstrapped.created).toBe(true);

    const redeemed = await post('/auth/credentials', {
      token: bootstrapped.setupToken,
      password: FOUNDER_PASSWORD,
    });
    expect(redeemed.status).toBe(204);

    const founder = await signIn(FOUNDER, FOUNDER_PASSWORD);

    const provisioned = await post(
      '/tenants',
      { name: 'Acme', administratorEmail: ADMINISTRATOR },
      founder.headers,
    );
    expect(provisioned.status).toBe(201);
    const { id: tenantId, administratorPersonId } = body<{
      id: string;
      administratorPersonId: string;
    }>(provisioned);

    const issued = await post(
      `/platform/people/${administratorPersonId}/setup-tokens`,
      undefined,
      founder.headers,
    );
    expect(issued.status).toBe(201);

    const established = await post('/auth/credentials', {
      token: body<{ setupToken: string }>(issued).setupToken,
      password: ADMINISTRATOR_PASSWORD,
    });
    expect(established.status).toBe(204);

    const administrator = await signIn(ADMINISTRATOR, ADMINISTRATOR_PASSWORD);

    const added = await post(
      `/tenants/${tenantId}/members`,
      { email: 'newcomer@acme.example.com', role: 'editor' },
      administrator.headers,
    );
    expect(added.status).toBe(201);

    const refreshed = await post('/auth/refresh', {
      refreshToken: administrator.session.refreshToken,
    });
    expect(refreshed.status).toBe(200);

    const out = await post('/auth/sign-out', {
      refreshToken: body<Session>(refreshed).refreshToken,
      everywhere: true,
    });
    expect(out.status).toBe(204);
    expect(
      (
        await post('/auth/refresh', {
          refreshToken: body<Session>(refreshed).refreshToken,
        })
      ).status,
    ).toBe(404);
  });

  it('can be run again without creating a second person', async () => {
    const first = await withMigrator((client) =>
      bootstrapOperator(client, FOUNDER, new Date()),
    );
    await post('/auth/credentials', {
      token: first.setupToken,
      password: FOUNDER_PASSWORD,
    });

    // The realistic reason to run it twice: the token was lost, or every
    // operator locked themselves out. It must be a way back in, not a way to a
    // duplicate account.
    const again = await withMigrator((client) =>
      bootstrapOperator(client, FOUNDER, new Date()),
    );

    expect(again.created).toBe(false);
    expect(again.personId).toBe(first.personId);
    expect(again.setupToken).not.toBe(first.setupToken);

    // The new token works; establishing a password through it ends the sessions
    // the old one bought, which is what redeeming has always done.
    const session = await signIn(FOUNDER, FOUNDER_PASSWORD);
    expect(
      (
        await post('/auth/credentials', {
          token: again.setupToken,
          password: 'something else entirely',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await post('/auth/refresh', {
          refreshToken: session.session.refreshToken,
        })
      ).status,
    ).toBe(404);
    expect(
      (await signInResponse(FOUNDER, 'something else entirely')).status,
    ).toBe(200);
  });

  it('grants the first operator nothing inside the tenant they provisioned', async () => {
    const bootstrapped = await withMigrator((client) =>
      bootstrapOperator(client, FOUNDER, new Date()),
    );
    await post('/auth/credentials', {
      token: bootstrapped.setupToken,
      password: FOUNDER_PASSWORD,
    });
    const founder = await signIn(FOUNDER, FOUNDER_PASSWORD);

    const provisioned = await post(
      '/tenants',
      { name: 'Acme', administratorEmail: ADMINISTRATOR },
      founder.headers,
    );
    const { id: tenantId } = body<{ id: string }>(provisioned);

    // The ceiling requirement 11.5 describes cuts both ways: an operator is
    // above every tenant and inside none of them.
    const inside = await request((await application()).getHttpServer())
      .get(`/tenants/${tenantId}/members`)
      .set(founder.headers);

    expect(inside.status).toBe(404);
  });

  describe('no request may assert its own principal', () => {
    it('ignores every header a caller might use to claim one', async () => {
      const { bootstrapped, founder } = await aFounderWithASession();

      // The headers the provisional middleware used to believe, now sent by
      // someone holding no credential at all.
      const claimed = await request((await application()).getHttpServer())
        .post('/tenants')
        .set({
          'x-actor-kind': 'platform-operator',
          'x-person-id': bootstrapped.personId,
          'x-platform-operator': 'true',
          'x-tenant-id': 'any',
          'x-role': 'admin',
        })
        .send({
          name: 'Theirs',
          administratorEmail: 'admin@theirs.example.com',
        });

      expect(claimed.status).toBe(404);
      expect(await tenantsSeenBy(founder.headers)).toEqual([]);
    });

    it('refuses a token this platform did not sign', async () => {
      const { bootstrapped, founder } = await aFounderWithASession();

      // Signed with a different secret, naming a person who really is an
      // operator. Only the signature separates it from the real thing.
      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        Buffer.from(
          JSON.stringify({
            sub: bootstrapped.personId,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        ).toString('base64url') +
        '.not-a-signature-this-platform-would-produce';

      const response = await request((await application()).getHttpServer())
        .post('/tenants')
        .set({ authorization: `Bearer ${forged}` })
        .send({
          name: 'Theirs',
          administratorEmail: 'admin@theirs.example.com',
        });

      expect(response.status).toBe(404);
      expect(await tenantsSeenBy(founder.headers)).toEqual([]);
    });
  });

  /**
   * The migration identity, connected directly. This is the harness standing in
   * for whoever runs `pnpm ops:bootstrap-operator`, and it calls the same
   * function the script's `main` calls — a test that reimplemented the act
   * would prove the act works and say nothing about the script.
   */
  async function withMigrator<T>(work: (client: Client) => Promise<T>) {
    const config = databaseConfig();
    const client = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.migrator.user,
      password: config.migrator.password,
    });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  /**
   * A founder who has been through the whole entrance: bootstrapped, password
   * established, signed in. The tests below need one anyway, to be able to
   * check afterwards that the refused request left nothing behind.
   */
  async function aFounderWithASession() {
    const bootstrapped = await withMigrator((client) =>
      bootstrapOperator(client, FOUNDER, new Date()),
    );
    await post('/auth/credentials', {
      token: bootstrapped.setupToken,
      password: FOUNDER_PASSWORD,
    });
    return { bootstrapped, founder: await signIn(FOUNDER, FOUNDER_PASSWORD) };
  }

  /** Asked through the route, so the check needs no privileged connection. */
  async function tenantsSeenBy(
    headers: Record<string, string>,
  ): Promise<unknown[]> {
    const app = await application();
    const listed = await request(app.getHttpServer())
      .get('/tenants')
      .set(headers);
    expect(listed.status).toBe(200);
    return body<unknown[]>(listed);
  }

  async function post(
    path: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const app = await application();
    const call = request(app.getHttpServer()).post(path).set(headers);
    return payload === undefined ? call : call.send(payload);
  }

  function signInResponse(email: string, password: string): Promise<Response> {
    return post('/auth/sign-in', { email, password });
  }

  async function signIn(
    email: string,
    password: string,
  ): Promise<{ headers: Record<string, string>; session: Session }> {
    const response = await signInResponse(email, password);
    expect(response.status).toBe(200);
    const session = body<Session>(response);
    return {
      headers: { authorization: `Bearer ${session.accessToken}` },
      session,
    };
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
