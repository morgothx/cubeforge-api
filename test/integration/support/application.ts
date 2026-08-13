import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import type { Response } from 'supertest';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { configure } from '../../../src/main';
import { asPersonInTenant } from './database';

export type Role = 'admin' | 'editor' | 'viewer';

/**
 * The provisional principal of an operator. The identifier is arbitrary until
 * authentication verifies operator status; feature 2's later tasks replace
 * these headers with a real credential.
 */
export const OPERATOR = {
  'x-actor-kind': 'platform-operator',
  'x-person-id': '018f2c00-0000-7000-8000-0000000000aa',
};

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

export function memberHeaders(
  tenantId: string,
  personId: string,
): Record<string, string> {
  return {
    'x-actor-kind': 'tenant-member',
    'x-tenant-id': tenantId,
    'x-person-id': personId,
  };
}

export interface SeededTenant {
  readonly id: string;
  readonly administrator: string;
  readonly headers: Record<string, string>;
}

/**
 * A tenant plus its first administrator.
 *
 * The membership is written directly because there is no route that could
 * create it: adding a member requires an administrator to already exist. That
 * bootstrap gap is real and belongs to feature 2, not to these tests.
 */
export async function seedTenantWithAdministrator(
  app: INestApplication<App>,
  name: string,
): Promise<SeededTenant> {
  const created = await request(app.getHttpServer())
    .post('/tenants')
    .set(OPERATOR)
    .send({ name });
  const { id } = body<{ id: string }>(created);

  const administrator = randomUUID();
  await asPersonInTenant(id, async (client) => {
    await client.query(
      'SELECT find_or_create_person($1::uuid, $2::citext, now())',
      [administrator, `admin-${id}@example.com`],
    );
    await client.query(
      'INSERT INTO memberships (id, tenant_id, person_id, role) VALUES ($1, $2, $3, $4)',
      [randomUUID(), id, administrator, 'admin'],
    );
  });

  return { id, administrator, headers: memberHeaders(id, administrator) };
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
