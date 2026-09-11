import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { describeVocabulary } from '../../src/domain/semantic/published-vocabulary';
import {
  addMember,
  bearerFor,
  body,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

jest.setTimeout(60_000);

/**
 * Differs per request by design, and nothing a caller could learn from: a
 * correlation identifier is new every time so two can be told apart in a log,
 * and the date moves on its own.
 */
const VOLATILE = new Set(['date', 'x-correlation-id', 'etag']);

function comparable(response: Response): unknown {
  return {
    status: response.status,
    body: response.text,
    headers: Object.fromEntries(
      Object.entries(response.headers as Record<string, string>).filter(
        ([name]) => !VOLATILE.has(name),
      ),
    ),
  };
}

interface IssuedKey {
  readonly id: string;
  readonly secret: string;
}

/**
 * The vocabulary route, through the application the entry point assembles.
 *
 * No export, no catalogue and no model are arranged here, on purpose: the
 * route reads none of them, and a suite that prepared them would hide the day
 * it started to.
 */
describe('describing what may be asked, over the running application', () => {
  useIntegrationDatabase();

  let app: INestApplication<App>;
  let acme: SeededTenant;
  let globex: SeededTenant;

  const vocabularyOf = (tenant: string) =>
    request(app.getHttpServer()).get(`/tenants/${tenant}/analytics/vocabulary`);

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    acme = await seedTenantWithAdministrator(app, `acme-${randomUUID()}`);
    globex = await seedTenantWithAdministrator(app, `globex-${randomUUID()}`);
  });

  it('answers an administrator, an editor and a viewer with the published vocabulary', async () => {
    const editor = await addMember(
      app,
      acme,
      `editor-${randomUUID()}@acme.example.com`,
      'editor',
    );
    const viewer = await addMember(
      app,
      acme,
      `viewer-${randomUUID()}@acme.example.com`,
      'viewer',
    );

    for (const headers of [
      acme.headers,
      await bearerFor(editor.personId),
      await bearerFor(viewer.personId),
    ]) {
      const answered = await vocabularyOf(acme.id).set(headers).expect(200);
      expect(answered.body).toEqual(describeVocabulary());
    }
  });

  /**
   * Nothing about a tenant reaches the vocabulary, so two tenants cannot be
   * told apart by it — compared as the bytes a caller receives, not as parsed
   * objects that would forgive a difference in order or spacing.
   */
  it('answers two tenants with the same bytes', async () => {
    const fromAcme = await vocabularyOf(acme.id).set(acme.headers).expect(200);
    const fromGlobex = await vocabularyOf(globex.id)
      .set(globex.headers)
      .expect(200);

    expect(fromGlobex.text).toBe(fromAcme.text);
  });

  /**
   * Three callers refused for three different reasons, and one response.
   *
   * A machine is refused on the kind of caller, not on its role: this key holds
   * `editor`, a role the route admits. Telling any of these apart from a tenant
   * that does not exist would let a caller confirm that one does — the leak the
   * platform refuses through data, arriving instead through the error channel.
   */
  it('answers a stranger, a machine key and a tenant that does not exist with the same bytes', async () => {
    const issued = await request(app.getHttpServer())
      .post(`/tenants/${acme.id}/api-keys`)
      .set(acme.headers)
      .send({ label: `key-${randomUUID()}`, role: 'editor' })
      .expect(201);
    const key = body<IssuedKey>(issued);

    const noSuchTenant = await vocabularyOf(randomUUID()).set(acme.headers);
    const stranger = await vocabularyOf(acme.id).set(
      await bearerFor(globex.administrator),
    );
    const machine = await vocabularyOf(acme.id).set({
      'x-api-key': key.secret,
    });

    expect(noSuchTenant.status).toBe(404);
    expect(noSuchTenant.body).toEqual({
      statusCode: 404,
      message: 'the requested record does not exist',
    });
    expect(comparable(stranger)).toEqual(comparable(noSuchTenant));
    expect(comparable(machine)).toEqual(comparable(noSuchTenant));
  });
});
