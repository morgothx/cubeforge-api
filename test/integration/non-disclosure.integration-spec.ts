import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { RandomSecretGenerator } from '../../src/adapters/crypto/random-secret-generator';
import {
  body,
  createApplication,
  operatorHeaders,
} from './support/application';
import { seed } from './support/database';
import {
  seedCredential,
  seedMember,
  seedTenant,
  useIntegrationDatabase,
} from './support/fixtures';

/**
 * Authentication answers every failure the same way, against real storage.
 *
 * The edge suite already asserts this shape with in-memory adapters, which is
 * where the throttling variants live because their limits are configurable
 * there. What it cannot show is that the answers stay identical once each
 * branch is a different query against a different table — an unknown address
 * never reaches the credential row, an address without a credential reaches it
 * and finds no digest, a wrong password reaches the digest and fails to verify.
 * Three code paths, three response bodies to compare.
 */
describe('authentication discloses nothing', () => {
  useIntegrationDatabase();

  const PASSWORD = 'correct horse battery staple';
  const secrets = new RandomSecretGenerator();

  /**
   * Status and body together, since either alone would let a difference
   * through. Headers are deliberately not compared: `x-correlation-id` differs
   * per request by design, and comparing it would only prove the harness sends
   * different requests.
   */
  function shapeOf(response: Response): unknown {
    return { status: response.status, body: response.body as unknown };
  }

  describe('signing in', () => {
    it('answers an unknown address, an address without a password and a wrong password identically', async () => {
      const app = await application();
      const tenant = await seedTenant({ name: 'Acme' });
      const withPassword = await seedMember({
        tenantId: tenant.id,
        email: 'has-password@acme.example.com',
      });
      await seedCredential(withPassword.personId, PASSWORD);
      const withoutPassword = await seedMember({
        tenantId: tenant.id,
        email: 'no-password@acme.example.com',
      });

      const answers = [
        await signIn(app, 'nobody@example.com', PASSWORD),
        await signIn(app, withoutPassword.email, PASSWORD),
        await signIn(app, withPassword.email, 'the wrong one entirely'),
      ].map(shapeOf);

      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
      // Named, so a future change that made every branch answer 500 would not
      // satisfy this test by making them equally broken.
      expect(answers[0]).toEqual({
        status: 404,
        body: {
          statusCode: 404,
          message: 'the requested record does not exist',
        },
      });
    });

    it('answers a deactivated person exactly as it answers a stranger', async () => {
      const app = await application();
      const tenant = await seedTenant({ name: 'Acme' });
      const deactivated = await seedMember({
        tenantId: tenant.id,
        email: 'former@acme.example.com',
        personStatus: 'deactivated',
      });
      await seedCredential(deactivated.personId, PASSWORD);

      // The password is correct. Whether this address is still someone here is
      // exactly what a caller may not learn.
      expect(shapeOf(await signIn(app, deactivated.email, PASSWORD))).toEqual(
        shapeOf(await signIn(app, 'nobody@example.com', PASSWORD)),
      );
    });
  });

  describe('redeeming a setup token', () => {
    it('answers a redeemed, an expired and an invented token identically', async () => {
      const app = await application();
      const tenant = await seedTenant({ name: 'Acme' });
      const person = await seedMember({
        tenantId: tenant.id,
        email: 'newcomer@acme.example.com',
      });

      const issued = await request(app.getHttpServer())
        .post(`/platform/people/${person.personId}/setup-tokens`)
        .set(await operatorHeaders());
      expect(issued.status).toBe(201);
      const alreadyRedeemed = body<{ setupToken: string }>(issued).setupToken;

      const first = await redeem(app, alreadyRedeemed, PASSWORD);
      expect(first.status).toBe(204);

      const expired = await seedExpiredSetupToken(person.personId);

      const answers = [
        await redeem(app, alreadyRedeemed, PASSWORD),
        await redeem(app, expired, PASSWORD),
        await redeem(app, secrets.generate(), PASSWORD),
      ].map(shapeOf);

      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
      expect(answers[0]).toEqual({
        status: 404,
        body: {
          statusCode: 404,
          message: 'the requested record does not exist',
        },
      });
    });

    it('leaves the established password alone when a stale token is presented', async () => {
      const app = await application();
      const tenant = await seedTenant({ name: 'Acme' });
      const person = await seedMember({
        tenantId: tenant.id,
        email: 'settled@acme.example.com',
      });
      await seedCredential(person.personId, PASSWORD);

      const expired = await seedExpiredSetupToken(person.personId);
      expect(
        (await redeem(app, expired, 'a password of my choosing')).status,
      ).toBe(404);

      // A refusal that changed the password would be a takeover dressed as an
      // error, so the old one must still buy a session and the new one must not.
      expect((await signIn(app, person.email, PASSWORD)).status).toBe(200);
      expect(
        (await signIn(app, person.email, 'a password of my choosing')).status,
      ).toBe(404);
    });
  });

  /**
   * A setup token whose expiry has already passed.
   *
   * Seeded rather than waited for: the lifetime is configuration, and a test
   * that slept through it would be the slowest in the suite and would still
   * only prove the clock works.
   */
  async function seedExpiredSetupToken(personId: string): Promise<string> {
    const secret = secrets.generate();
    await seed((client) =>
      client.query(
        `INSERT INTO credential_setup_tokens (id, person_id, secret_digest, expires_at)
         VALUES ($1, $2, $3, now() - interval '1 hour')`,
        [randomUUID(), personId, secrets.digest(secret)],
      ),
    );
    return secret;
  }

  function signIn(
    app: INestApplication<App>,
    email: string,
    password: string,
  ): Promise<Response> {
    return request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password });
  }

  function redeem(
    app: INestApplication<App>,
    token: string,
    password: string,
  ): Promise<Response> {
    return request(app.getHttpServer())
      .post('/auth/credentials')
      .send({ token, password });
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
