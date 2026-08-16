import { Logger, type INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  addMember,
  bearerFor,
  createApplication,
  seedTenantWithAdministrator,
} from './support/application';
import { useIntegrationDatabase } from './support/fixtures';

/**
 * What a refused caller learns, which must be nothing.
 *
 * The three refusals below have three different causes: a member whose role is
 * wrong, a person with no standing in this tenant at all, and a caller
 * presenting no credential. Telling them apart would let someone confirm that a
 * tenant exists, that they are in it, or that an identifier is real somewhere on
 * the platform — the same cross-tenant leak the platform already refuses to make
 * through data, arriving instead through the error channel.
 *
 * The distinction is not discarded. It goes to the log, where operators read it
 * and callers do not.
 */
describe('what a refusal discloses', () => {
  useIntegrationDatabase();

  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Volatile by design and excluded from the comparison: a correlation
   * identifier differs per request precisely so two requests can be told apart
   * in the log, and the date moves on its own.
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

  async function threeRefusals(): Promise<{
    wrongRole: Response;
    noMembership: Response;
    noCredential: Response;
    reasons: string[];
  }> {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const globex = await seedTenantWithAdministrator(app, 'Globex');
    const viewer = await addMember(
      app,
      acme,
      'viewer@acme.example.com',
      'viewer',
    );

    const logged: string[] = [];
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });

    try {
      // Managing API keys is the administrator's, so a viewer of this tenant is
      // a member holding the wrong role — the one case that is a denial rather
      // than an absence, and the one a caller must not be able to detect.
      const keys = `/tenants/${acme.id}/api-keys`;
      return {
        wrongRole: await request(app.getHttpServer())
          .get(keys)
          .set(await bearerFor(viewer.personId)),
        noMembership: await request(app.getHttpServer())
          .get(keys)
          .set(await bearerFor(globex.administrator)),
        noCredential: await request(app.getHttpServer()).get(keys),
        reasons: logged,
      };
    } finally {
      warn.mockRestore();
    }
  }

  it('answers the wrong role and no standing with the same bytes', async () => {
    const { wrongRole, noMembership } = await threeRefusals();

    expect(comparable(wrongRole)).toEqual(comparable(noMembership));
    expect(wrongRole.status).toBe(404);
    expect(wrongRole.body).toEqual({
      statusCode: 404,
      message: 'the requested record does not exist',
    });
  });

  it('answers a caller with no credential the same way as both', async () => {
    const { wrongRole, noCredential } = await threeRefusals();

    // Requirement 5.5: presenting nothing and presenting the wrong thing are
    // indistinguishable, so an attacker learns nothing by trying a credential.
    expect(comparable(noCredential)).toEqual(comparable(wrongRole));
  });

  it('says nothing in the response about why', async () => {
    const { wrongRole, noMembership, noCredential } = await threeRefusals();

    for (const response of [wrongRole, noMembership, noCredential]) {
      const serialized = JSON.stringify(response.body).toLowerCase();
      for (const giveaway of [
        'role',
        'admin',
        'viewer',
        'membership',
        'tenant',
        'forbidden',
        'principal',
        'credential',
      ]) {
        expect(serialized).not.toContain(giveaway);
      }
    }
  });

  it('tells all three apart in the log, where only operators read', async () => {
    const { reasons } = await threeRefusals();

    // Three requests, three distinct causes recorded. Without this the
    // indistinguishable responses above would mean the platform itself could
    // not explain a refusal either, which is a different failure wearing the
    // same clothes.
    const distinct = new Set(reasons.map((line) => line.replace(/^\S+\s/, '')));
    expect(distinct.size).toBe(3);

    // Not merely three different lines — three lines that each say what
    // happened. `forbidden` and `not-found` alone would satisfy "distinct"
    // while leaving an operator to guess which of four access refusals it was.
    const log = [...distinct].join('\n');
    expect(log).toMatch(/this caller is a viewer here/);
    expect(log).toMatch(/no principal|none was resolved/);
    // "no such person", not "no membership": from inside Acme's transaction
    // row-level security has already hidden the Globex administrator, so the
    // access decision never runs on them. The second isolation layer answers
    // first, and the log says what actually happened rather than what the
    // authorization code would have concluded.
    expect(log).toMatch(/no such person/);
  });

  it('carries a correlation identifier on every refusal', async () => {
    const { wrongRole, noMembership, noCredential } = await threeRefusals();

    // The one thing a caller does get, and the only way an operator can match
    // a complaint to the line that explains it.
    for (const response of [wrongRole, noMembership, noCredential]) {
      expect(response.headers['x-correlation-id']).toMatch(/\S/);
    }
    expect(wrongRole.headers['x-correlation-id']).not.toBe(
      noMembership.headers['x-correlation-id'],
    );
  });
});
