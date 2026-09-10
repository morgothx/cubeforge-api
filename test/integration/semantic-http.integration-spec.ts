import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { loadAnalyticsConfig } from '../../src/adapters/analytics/analytics-config';
import { GlueCatalogue } from '../../src/adapters/analytics/glue-catalogue';
import { CubeClient } from '../../src/adapters/semantic/cube-client';
import { CubeModel } from '../../src/adapters/semantic/cube-model';
import { DeferredModel } from '../../src/adapters/semantic/deferred-model';
import { SignedSecurityContext } from '../../src/adapters/semantic/security-context';
import { loadSemanticConfig } from '../../src/adapters/semantic/semantic-config';
import { RunExportUseCase } from '../../src/application/export/run-export.use-case';
import { TENANT_SCOPED_MODEL } from '../../src/application/ports/tenant-scoped-model';
import { tenantId } from '../../src/domain/identifiers';
import { ExportModule } from '../../src/export.module';
import {
  addMember,
  bearerFor,
  body,
  createApplication,
  seedTenantWithAdministrator,
  type SeededTenant,
} from './support/application';
import { asPersonInTenant, seed } from './support/database';
import { useIntegrationDatabase } from './support/fixtures';
import {
  exportDestination,
  useExportDestination,
} from './support/object-storage';

jest.setTimeout(120_000);

/** A port nothing is listening on, which is what "stopped" means here. */
const NOWHERE = 'http://localhost:4599';

const A_QUESTION = {
  measures: ['net_quantity'],
  from: '2026-08-01',
  to: '2026-08-31',
};

/**
 * Volatile by design and excluded from any comparison: a correlation identifier
 * differs per request precisely so two can be told apart in a log, and the date
 * moves on its own.
 */
const VOLATILE = new Set(['date', 'x-correlation-id', 'etag']);

function comparable(response: Response): unknown {
  return {
    status: response.status,
    body: response.body as unknown,
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
 * The modelled route, through the application the entry point assembles.
 *
 * The model's own suites prove the answers. This one is about the edge nothing
 * stands in front of: who is admitted, what a body may decide, what a refusal
 * discloses, and — the assertion that matters most operationally — that a
 * semantic layer nobody can reach refuses these questions and only these.
 */
describe('asking a composed question of the running application', () => {
  useIntegrationDatabase();
  useExportDestination();

  let app: INestApplication<App>;
  let acme: SeededTenant;
  let globex: SeededTenant;

  const ask = (tenant: string) =>
    request(app.getHttpServer()).post(`/tenants/${tenant}/analytics/questions`);

  /**
   * One export with rows in it, so every prefix the model reads exists.
   *
   * Its numbers are nobody's business here — what matters is that the objects
   * are there. The engine builds a view over **every** cube when it compiles
   * the model, so an empty `movements/` prefix refuses a question that only
   * touches `watermarks`, and every request would come back refused for a
   * reason that has nothing to do with who asked. A tenant with no movements
   * writes a watermark and no movements, which is exactly the shape that fails.
   */
  async function objectsExist(through: INestApplication<App>): Promise<void> {
    const seeded = await seedTenantWithAdministrator(
      through,
      `carried-${randomUUID()}`,
    );

    await seed(async (database) => {
      await database.query(
        `INSERT INTO inventory_products (id, tenant_id, sku, name, category)
         VALUES (gen_random_uuid(), $1, 'W-1', 'a widget', 'hardware')`,
        [seeded.id],
      );
      await database.query(
        `INSERT INTO inventory_locations (id, tenant_id, code, name)
         VALUES (gen_random_uuid(), $1, 'WH-1', 'a warehouse')`,
        [seeded.id],
      );
    });

    await asPersonInTenant(tenantId(seeded.id), (database) =>
      database.query(
        `INSERT INTO stock_movements
           (id, tenant_id, external_id, sku, location_code, kind, quantity,
            occurred_at, recorded_at)
         VALUES ($1, $2, 'ERP-1', 'W-1', 'WH-1', 'receipt', 1, $3, $4)`,
        [
          randomUUID(),
          seeded.id,
          new Date('2026-08-10T09:00:00.000Z'),
          new Date('2026-08-10T02:00:00.000Z'),
        ],
      ),
    );

    const exporting = await NestFactory.createApplicationContext(ExportModule, {
      logger: false,
    });
    try {
      await exporting.get(RunExportUseCase).execute({
        correlationId: randomUUID(),
        onlyTenant: tenantId(seeded.id),
      });
    } finally {
      await exporting.close();
    }

    const catalogue = new GlueCatalogue(
      loadAnalyticsConfig(process.env),
      exportDestination().bucket,
    );
    try {
      await catalogue.apply();
    } finally {
      catalogue.close();
    }
  }

  describe('who may ask, and what a body may decide', () => {
    beforeAll(async () => {
      app = await createApplication();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await objectsExist(app);
      acme = await seedTenantWithAdministrator(app, `acme-${randomUUID()}`);
      globex = await seedTenantWithAdministrator(app, `globex-${randomUUID()}`);
    });

    /**
     * Answered, not merely admitted. These tenants have never been exported, so
     * the honest answer is that they were never carried — a 200 carrying a
     * state, which is what reaching the model looks like from outside.
     */
    it('admits an administrator, an editor and a viewer alike', async () => {
      for (const role of ['editor', 'viewer'] as const) {
        const member = await addMember(
          app,
          acme,
          `${role}-${randomUUID()}@acme.example.com`,
          role,
        );

        const answered = await ask(acme.id)
          .set(await bearerFor(member.personId))
          .send(A_QUESTION)
          .expect(200);

        expect(answered.body).toEqual({ state: 'never-exported' });
      }

      await ask(acme.id).set(acme.headers).send(A_QUESTION).expect(200);
    });

    /**
     * A machine is refused on the kind of caller, not on the role it holds.
     *
     * The key below is issued as an `editor`, which is a role this route
     * admits. An analytical question is expensive, and admitting keys would let
     * an automated client decide how often that cost is paid.
     */
    it('does not admit a machine credential, whatever role it holds', async () => {
      const issued = await request(app.getHttpServer())
        .post(`/tenants/${acme.id}/api-keys`)
        .set(acme.headers)
        .send({ label: `key-${randomUUID()}`, role: 'editor' })
        .expect(201);
      const key = body<IssuedKey>(issued);

      await ask(acme.id)
        .set({ 'x-api-key': key.secret })
        .send(A_QUESTION)
        .expect(404);
    });

    /**
     * Three different causes, one response.
     *
     * Telling them apart would let a caller confirm that a tenant is real, or
     * that they were once in it — the cross-tenant leak the platform refuses to
     * make through data, arriving instead through the error channel.
     */
    it('answers no membership, a revoked one and no such tenant with the same bytes', async () => {
      const revoked = await addMember(
        app,
        acme,
        `leaver-${randomUUID()}@acme.example.com`,
        'viewer',
      );
      await request(app.getHttpServer())
        .delete(`/tenants/${acme.id}/members/${revoked.membershipId}`)
        .set(acme.headers)
        .expect(204);

      const noStanding = await ask(acme.id)
        .set(await bearerFor(globex.administrator))
        .send(A_QUESTION);
      const wasAMember = await ask(acme.id)
        .set(await bearerFor(revoked.personId))
        .send(A_QUESTION);
      const noSuchTenant = await ask(randomUUID())
        .set(acme.headers)
        .send(A_QUESTION);

      expect(comparable(wasAMember)).toEqual(comparable(noStanding));
      expect(comparable(noSuchTenant)).toEqual(comparable(noStanding));
      expect(noStanding.status).toBe(404);
      expect(noStanding.body).toEqual({
        statusCode: 404,
        message: 'the requested record does not exist',
      });
    });

    /**
     * The path and the caller's standing decide, and nothing else.
     *
     * A body naming another tenant is refused outright rather than ignored:
     * there is no reading of this request in which the other tenant's rows
     * could arrive, and the caller is told the platform will not do that rather
     * than left believing their field worked.
     */
    it('does not honour a tenant named in the body', async () => {
      const refused = await ask(acme.id)
        .set(acme.headers)
        .send({ ...A_QUESTION, tenantId: globex.id })
        .expect(400);

      expect(JSON.stringify(refused.body)).not.toContain(globex.id);
    });

    it('refuses a name the model does not define, and one the platform will not span', async () => {
      const unknown = await ask(acme.id)
        .set(acme.headers)
        .send({ ...A_QUESTION, measures: ['revenue'] })
        .expect(400);
      expect(JSON.stringify(unknown.body)).toContain('revenue');

      await ask(acme.id)
        .set(acme.headers)
        .send({ ...A_QUESTION, from: '2025-01-01', to: '2026-06-30' })
        .expect(400);
    });
  });

  /**
   * The semantic layer stopped, and only these questions refused.
   *
   * This is the operational claim the feature makes: a capability that cannot
   * be reached takes down the questions that need it and nothing else. A
   * platform where an unreachable analytical service also stopped sign-in would
   * be one nobody could safely deploy it into.
   */
  describe('when nothing is listening where the model should be', () => {
    let unreachable: INestApplication<App>;
    let tenant: SeededTenant;

    beforeAll(async () => {
      const config = { ...loadSemanticConfig(process.env), url: NOWHERE };

      unreachable = await createApplication([
        {
          token: TENANT_SCOPED_MODEL,
          value: new DeferredModel(
            () =>
              new CubeModel(
                new CubeClient(config),
                new SignedSecurityContext(config),
                () => new Date(),
              ),
          ),
        },
      ]);
    });

    afterAll(async () => {
      await unreachable.close();
    });

    /**
     * Seeded per test, not once.
     *
     * The suite resets the database before every test, and Jest runs that after
     * this block's `beforeAll` — so a tenant created there is already gone when
     * the first test runs, and every request answers as for a tenant that does
     * not exist. Which is a perfectly good 404, and would have hidden all three
     * assertions below behind one.
     */
    beforeEach(async () => {
      tenant = await seedTenantWithAdministrator(
        unreachable,
        `acme-${randomUUID()}`,
      );
    });

    it('reports the question unavailable rather than broken', async () => {
      const refused = await request(unreachable.getHttpServer())
        .post(`/tenants/${tenant.id}/analytics/questions`)
        .set(tenant.headers)
        .send(A_QUESTION);

      expect(refused.status).toBe(503);
    });

    it('goes on answering everything that does not need the model', async () => {
      // Inventory reads the transactional database, which is answering fine.
      await request(unreachable.getHttpServer())
        .get(`/tenants/${tenant.id}/inventory/products`)
        .set(tenant.headers)
        .expect(200);

      // And the caller's own standing resolves, which is sign-in's business.
      await request(unreachable.getHttpServer())
        .get('/me')
        .set(tenant.headers)
        .expect(200);
    });

    /**
     * A class of problem, and nothing else.
     *
     * A query layer's error body routinely carries the statement it generated
     * and the address it read from. Neither may reach a caller, and neither may
     * an identifier belonging to anyone.
     */
    it('discloses no statement, no location and no identifier', async () => {
      const refused = await request(unreachable.getHttpServer())
        .post(`/tenants/${tenant.id}/analytics/questions`)
        .set(tenant.headers)
        .send(A_QUESTION);

      const said = JSON.stringify({
        body: refused.body as unknown,
        headers: refused.headers as unknown,
      });

      for (const secret of [
        'SELECT',
        'localhost',
        '4599',
        'cubejs',
        tenant.id,
        tenant.administrator,
      ]) {
        expect(said).not.toContain(secret);
      }
    });
  });
});
