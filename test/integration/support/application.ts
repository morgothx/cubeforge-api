import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import type { Response } from 'supertest';
import request from 'supertest';
import {
  JwtAccessTokenIssuer,
  loadTokenConfig,
} from '../../../src/adapters/crypto/access-token-issuer';
import { personId as toPersonId } from '../../../src/domain/identifiers';
import { AppModule } from '../../../src/app.module';
import { configure } from '../../../src/main';
import { seed } from './database';

export type Role = 'admin' | 'editor' | 'viewer';

const OPERATOR_PERSON = '018f2c00-0000-7000-8000-0000000000aa';

/**
 * A real bearer token for a person recorded as an operator.
 *
 * Headers used to be enough: the provisional middleware believed whatever a
 * request claimed. They are not any more, which is the point of task 6.2 — so
 * the harness has to arrange a credential like everyone else.
 */
export async function operatorHeaders(): Promise<Record<string, string>> {
  await seed((client) =>
    client.query(
      `INSERT INTO people (id, email) VALUES ($1, 'operator@example.com')
       ON CONFLICT (id) DO NOTHING`,
      [OPERATOR_PERSON],
    ),
  );
  await seed((client) =>
    client.query(
      `INSERT INTO platform_operators (person_id) VALUES ($1)
       ON CONFLICT (person_id) DO NOTHING`,
      [OPERATOR_PERSON],
    ),
  );
  return bearerFor(OPERATOR_PERSON);
}

/** Signs a token with the same configuration the running application uses. */
export async function bearerFor(
  personId: string,
): Promise<Record<string, string>> {
  const issuer = new JwtAccessTokenIssuer(loadTokenConfig(process.env));
  return {
    authorization: `Bearer ${await issuer.issue(toPersonId(personId), new Date())}`,
  };
}

/** Supertest types `body` as `any`; naming the shape keeps assertions honest. */
export function body<T>(response: Response): T {
  return response.body as T;
}

/**
 * The application assembled exactly as `main.ts` assembles it. Sharing this
 * rather than each suite building its own is the point: what the validation
 * suites exercise has to be what runs.
 */
export async function createApplication(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  configure(app);
  await app.init();
  return app;
}

/**
 * The tenant is no longer part of the credential: a token names a person, and
 * the tenant comes from the path. The parameter is kept so call sites still
 * read as "acting in this tenant as this person".
 */
export async function memberHeaders(
  _tenantId: string,
  personId: string,
): Promise<Record<string, string>> {
  return bearerFor(personId);
}

export interface SeededTenant {
  readonly id: string;
  readonly administrator: string;
  readonly headers: Record<string, string>;
}

/**
 * A tenant plus its first administrator, both created by the route.
 *
 * This used to insert the membership with raw SQL, because no route could
 * create it. Task 4.5 closed that gap: provisioning names the administrator.
 * The identifier is read back through a privileged connection only because the
 * response deliberately does not disclose it.
 */
export async function seedTenantWithAdministrator(
  app: INestApplication<App>,
  name: string,
): Promise<SeededTenant> {
  const created = await request(app.getHttpServer())
    .post('/tenants')
    .set(await operatorHeaders())
    .send({ name, administratorEmail: `admin-${name}@example.com` });
  if (created.status !== 201) {
    throw new Error(
      `provisioning failed with ${created.status}: ${JSON.stringify(created.body)}`,
    );
  }
  const { id } = body<{ id: string }>(created);

  const administrator = await seed(async (client) => {
    const { rows } = await client.query<{ person_id: string }>(
      'SELECT person_id FROM memberships WHERE tenant_id = $1',
      [id],
    );
    return rows[0].person_id;
  });

  return {
    id,
    administrator,
    headers: await memberHeaders(id, administrator),
  };
}

export interface EstablishedSession {
  readonly headers: Record<string, string>;
  readonly refreshToken: string;
}

/**
 * A session obtained the way a person actually obtains one: an operator issues
 * a setup token, the holder redeems it into a password, and that password buys
 * a session.
 *
 * `bearerFor` mints a token directly, which is a genuine credential — the
 * resolver verifies its signature like any other — and is what most suites use,
 * because arranging a password costs two Argon2 hashes per principal and proves
 * nothing they are testing. This is for the suites where the credential path
 * *is* the subject.
 */
export async function signInThrough(
  app: INestApplication<App>,
  personId: string,
  email: string,
  password: string,
): Promise<EstablishedSession> {
  const issued = await request(app.getHttpServer())
    .post(`/platform/people/${personId}/setup-tokens`)
    .set(await operatorHeaders());
  expectStatus(issued, 201, 'issuing a setup token');

  const redeemed = await request(app.getHttpServer())
    .post('/auth/credentials')
    .send({ token: body<{ setupToken: string }>(issued).setupToken, password });
  expectStatus(redeemed, 204, 'redeeming a setup token');

  const signedIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password });
  expectStatus(signedIn, 200, 'signing in');

  const session = body<{ accessToken: string; refreshToken: string }>(signedIn);
  return {
    headers: { authorization: `Bearer ${session.accessToken}` },
    refreshToken: session.refreshToken,
  };
}

function expectStatus(response: Response, status: number, step: string): void {
  if (response.status !== status) {
    throw new Error(
      `${step} failed with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
}

/** Adds a member through the API, the way an administrator would. */
export async function addMember(
  app: INestApplication<App>,
  tenant: SeededTenant,
  email: string,
  role: Role,
): Promise<{ personId: string; membershipId: string }> {
  const response = await request(app.getHttpServer())
    .post(`/tenants/${tenant.id}/members`)
    .set(tenant.headers)
    .send({ email, role });

  if (response.status !== 201) {
    throw new Error(
      `seeding a member failed with ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return body<{ personId: string; membershipId: string }>(response);
}
