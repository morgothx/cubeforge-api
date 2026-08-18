import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Response } from 'supertest';
import { JwtAccessTokenIssuer } from '../crypto/access-token-issuer';
import { Argon2PasswordHasher } from '../crypto/argon2-password-hasher';
import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../testing/identity-test-context';
import { createInMemoryApplication } from '../testing/in-memory-application';
import { personId as toPersonId } from '../../domain/identifiers';
import type { CallerResponse } from './dto/responses';

function body<T>(response: Response): T {
  return response.body as T;
}

/**
 * `GET /me`, through the assembled application.
 *
 * The route is the first in the platform that names no tenant and is not an
 * operator's, so what these assert is as much about the composition as about
 * the handler: the declaration is `{ person: true }`, the principal comes from
 * the token and from nowhere else, and there is no argument anywhere that
 * could name somebody other than the caller.
 */
describe('the caller route', () => {
  let app: INestApplication<App>;
  let context: IdentityTestContext;

  const tokens = new JwtAccessTokenIssuer({
    secret: 'a-signing-secret-long-enough-for-the-rule',
    accessTokenLifetimeSeconds: 900,
  });
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });
  const THROTTLING = {
    windowSeconds: 60,
    cooldownSeconds: 60,
    signInAttemptsPerAddress: 3,
    signInAttemptsPerOrigin: 8,
    redemptionsPerOrigin: 3,
  };

  async function bearer(person: string): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await tokens.issue(
        toPersonId(person),
        context.clock.now(),
      )}`,
    };
  }

  beforeEach(async () => {
    context = createIdentityTestContext();
    app = await createInMemoryApplication({
      context,
      hasher,
      tokens,
      throttling: THROTTLING,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a member with their own standing', async () => {
    const acme = await context.seedTenant('Acme');
    const caller = await context.seedMember({
      tenantId: acme,
      email: 'caller@example.com',
      role: 'editor',
    });

    const response = await request(app.getHttpServer())
      .get('/me')
      .set(await bearer(caller))
      .expect(200);

    expect(body<CallerResponse>(response)).toEqual({
      personId: caller,
      email: 'caller@example.com',
      isOperator: false,
      memberships: [{ tenantId: acme, tenantName: 'Acme', role: 'editor' }],
    });
  });

  it('answers an operator, with the flag and their own memberships only', async () => {
    await context.seedTenant('Acme');
    const founder = context.seedOperator(
      toPersonId('018f2c00-0000-7000-8000-0000000000aa'),
      'founder@example.com',
    );

    const response = await request(app.getHttpServer())
      .get('/me')
      .set(await bearer(founder))
      .expect(200);

    expect(body<CallerResponse>(response)).toEqual({
      personId: founder,
      email: 'founder@example.com',
      isOperator: true,
      memberships: [],
    });
  });

  it('refuses a caller with no credential as an absence', async () => {
    await request(app.getHttpServer()).get('/me').expect(404);
  });

  it('refuses a machine, which names a credential rather than a person', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const issued = await request(app.getHttpServer())
      .post(`/tenants/${acme}/api-keys`)
      .set(await bearer(admin))
      .send({ label: 'sync', role: 'viewer' })
      .expect(201);

    await request(app.getHttpServer())
      .get('/me')
      .set({ 'x-api-key': body<{ secret: string }>(issued).secret })
      .expect(404);
  });

  it('offers no way to ask about anybody else', async () => {
    const acme = await context.seedTenant('Acme');
    const caller = await context.seedMember({
      tenantId: acme,
      email: 'caller@example.com',
      role: 'viewer',
    });
    const other = await context.seedMember({
      tenantId: acme,
      email: 'other@example.com',
      role: 'admin',
    });

    // Requirement 2.3, asserted at the edge: there is no path segment for a
    // person, and a query string naming one changes nothing. Whoever the token
    // names is who the answer describes.
    const response = await request(app.getHttpServer())
      .get(`/me?personId=${other}`)
      .set(await bearer(caller))
      .expect(200);

    expect(body<CallerResponse>(response).personId).toBe(caller);

    await request(app.getHttpServer())
      .get(`/me/${other}`)
      .set(await bearer(caller))
      .expect(404);
  });
});
