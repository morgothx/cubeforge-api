import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PostgresAuthenticatorUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-authenticator-unit-of-work';
import type { StandingContractWorld } from '../../src/adapters/testing/standing-repository.contract';
import { describesCallerStanding } from '../../src/adapters/testing/standing-repository.contract';
import {
  personId as toPersonId,
  tenantId as toTenantId,
} from '../../src/domain/identifiers';
import type { CallerResponse } from '../../src/adapters/http/dto/responses';
import {
  addMember,
  bearerFor,
  body,
  createApplication,
  operatorHeaders,
  seedTenantWithAdministrator,
  signInThrough,
} from './support/application';
import { runtimePool, seed } from './support/database';
import { seedOperator } from './support/fixtures';
import { useIntegrationDatabase } from './support/fixtures';

/**
 * The real standing repository, held to the same contract as the double.
 *
 * The double passing this suite is what earns every use-case test that trusts
 * it; this one passing is what says the double was telling the truth. Neither
 * is worth much alone, which is why the assertions live in one place and only
 * the seeding differs.
 *
 * Fixtures are written as the superuser because forced row-level security
 * leaves no runtime identity able to insert a membership — the authenticating
 * one holds `SELECT` and nothing else, which is itself asserted elsewhere.
 */
describe('the standing repository against PostgreSQL', () => {
  useIntegrationDatabase();

  let world: StandingContractWorld;

  beforeEach(() => {
    const unitOfWork = new PostgresAuthenticatorUnitOfWork(
      drizzle(runtimePool('authenticator')),
    );

    world = {
      seedPerson: async (input) => {
        const id = randomUUID();
        await seed((client) =>
          client.query(
            'INSERT INTO people (id, email, status) VALUES ($1, $2, $3)',
            [id, input.email, input.deactivated ? 'deactivated' : 'active'],
          ),
        );
        return toPersonId(id);
      },
      seedTenant: async (input) => {
        const id = randomUUID();
        await seed((client) =>
          client.query(
            'INSERT INTO tenants (id, name, status) VALUES ($1, $2, $3)',
            [id, input.name, input.inactive ? 'inactive' : 'active'],
          ),
        );
        return toTenantId(id);
      },
      seedMembership: async (input) => {
        await seed((client) =>
          client.query(
            `INSERT INTO memberships (id, tenant_id, person_id, role, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              randomUUID(),
              input.tenantId,
              input.personId,
              input.role,
              input.revoked ? 'revoked' : 'active',
            ],
          ),
        );
      },
      recordOperator: (person) => seedOperator(person),
      anUnknownPerson: () => toPersonId(randomUUID()),
      describeCaller: (person) =>
        unitOfWork.runAsPerson(person, ({ standing }) =>
          standing.describeCaller(),
        ),
    };
  });

  describesCallerStanding(() => world);
});

/**
 * `GET /me` end to end: the assembled application, the real database, real
 * credentials.
 *
 * Everything above proves the read is confined and that the double tells the
 * truth about it. This proves the feature — that a client which has just
 * signed in can learn where it may act, and that what it learns is current
 * rather than whatever was true when its token was issued.
 *
 * Every freshness test reuses one `Authorization` header across the change it
 * makes. That is the assertion, not an economy: if the standing were carried in
 * the credential, or cached against it, the second call would answer the first
 * call's world and the test would fail.
 */
describe('a caller asking who they are', () => {
  useIntegrationDatabase();

  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  function standingOf(headers: Record<string, string>) {
    return request(server()).get('/me').set(headers);
  }

  it('tells a member their address and the one tenant they belong to', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const member = await addMember(
      app,
      acme,
      'editor@acme.example.com',
      'editor',
    );

    const response = await standingOf(await bearerFor(member.personId)).expect(
      200,
    );

    expect(body<CallerResponse>(response)).toEqual({
      personId: member.personId,
      email: 'editor@acme.example.com',
      isOperator: false,
      memberships: [{ tenantId: acme.id, tenantName: 'Acme', role: 'editor' }],
    });
  });

  it('tells a person holding two roles about both tenants', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const globex = await seedTenantWithAdministrator(app, 'Globex');
    const here = await addMember(app, acme, 'dual@example.com', 'admin');
    await addMember(app, globex, 'dual@example.com', 'viewer');

    const response = await standingOf(await bearerFor(here.personId)).expect(
      200,
    );

    // One person, one credential, two tenants and two different roles — the
    // read `cubeforge_app` cannot perform, because it would have to know which
    // tenants to open a transaction for, which is the question being asked.
    expect(body<CallerResponse>(response).memberships).toEqual([
      { tenantId: acme.id, tenantName: 'Acme', role: 'admin' },
      { tenantId: globex.id, tenantName: 'Globex', role: 'viewer' },
    ]);
  });

  it('tells an operator they are one, and names only tenants they joined', async () => {
    await seedTenantWithAdministrator(app, 'Acme');

    const response = await standingOf(await operatorHeaders()).expect(200);

    // Requirement 1.4: Acme exists and the operator can administer it, and it
    // is still absent — an operator is a member of nothing by being one.
    expect(body<CallerResponse>(response)).toEqual({
      personId: expect.any(String) as string,
      email: 'operator@example.com',
      isOperator: true,
      memberships: [],
    });
  });

  it('answers a caller who belongs nowhere with the shape everyone else gets', async () => {
    const stranger = randomUUID();
    await seed((client) =>
      client.query('INSERT INTO people (id, email) VALUES ($1, $2)', [
        stranger,
        'stranger@example.com',
      ]),
    );

    const response = await standingOf(await bearerFor(stranger)).expect(200);

    // Requirement 2.4. An empty list is an ordinary answer; refusing here would
    // tell a caller that belonging somewhere is what makes the route work.
    expect(body<CallerResponse>(response).memberships).toEqual([]);
  });

  it('refuses a machine and a caller with no credential identically', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const issued = await request(server())
      .post(`/tenants/${acme.id}/api-keys`)
      .set(acme.headers)
      .send({ label: 'sync', role: 'admin' })
      .expect(201);

    const machine = await standingOf({
      'x-api-key': body<{ secret: string }>(issued).secret,
    });
    const anonymous = await request(server()).get('/me');

    // Requirements 3.2 and 3.3: two different reasons, one answer. A machine
    // key is valid and admits its holder to seven other routes; nothing in
    // this response says so.
    //
    // Refused twice over, which a probe established rather than the design:
    // both refusals come from the guard, which is why they are identical by
    // construction — and if the guard ever let a machine through, the use case
    // would still refuse it, because a machine actor names no person and there
    // is nothing to describe. Breaking both is what makes this assertion fail.
    type Refusal = { statusCode: number; message: string };
    expect(machine.status).toBe(404);
    expect({
      status: anonymous.status,
      body: body<Refusal>(anonymous),
    }).toEqual({ status: machine.status, body: body<Refusal>(machine) });
  });

  it('reports a changed role the next time, with the credential unchanged', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const member = await addMember(
      app,
      acme,
      'promoted@acme.example.com',
      'viewer',
    );
    const credential = await bearerFor(member.personId);
    // Asked before the change, on purpose. Without this the second call is the
    // first, and a standing cached against the caller would satisfy the
    // assertion below — which is exactly what this test is here to rule out.
    expect(
      body<CallerResponse>(await standingOf(credential).expect(200))
        .memberships,
    ).toEqual([{ tenantId: acme.id, tenantName: 'Acme', role: 'viewer' }]);

    await request(server())
      .patch(`/tenants/${acme.id}/members/${member.membershipId}`)
      .set(acme.headers)
      .send({ role: 'admin' })
      .expect(204);

    const after = await standingOf(credential).expect(200);

    // Requirement 4.1, and the reason roles are not a token claim: this same
    // header answered `viewer` a moment ago.
    expect(body<CallerResponse>(after).memberships).toEqual([
      { tenantId: acme.id, tenantName: 'Acme', role: 'admin' },
    ]);
  });

  it('omits a tenant whose membership was revoked, with the credential unchanged', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const member = await addMember(
      app,
      acme,
      'leaving@acme.example.com',
      'editor',
    );
    const credential = await bearerFor(member.personId);
    expect(
      body<CallerResponse>(await standingOf(credential)).memberships,
    ).toHaveLength(1);

    await request(server())
      .delete(`/tenants/${acme.id}/members/${member.membershipId}`)
      .set(acme.headers)
      .expect(204);

    // Requirement 4.2, and requirement 1.3's promise made observable: what this
    // route reports is what the caller can actually reach, so a revoked member
    // is told nothing rather than told about a tenant that would refuse them.
    expect(
      body<CallerResponse>(await standingOf(credential).expect(200))
        .memberships,
    ).toEqual([]);
  });

  it('omits a tenant that was deactivated, with the credential unchanged', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const member = await addMember(
      app,
      acme,
      'stranded@acme.example.com',
      'admin',
    );
    const credential = await bearerFor(member.personId);
    expect(
      body<CallerResponse>(await standingOf(credential).expect(200))
        .memberships,
    ).toHaveLength(1);

    await request(server())
      .delete(`/tenants/${acme.id}`)
      .set(await operatorHeaders())
      .expect(204);

    // The membership is untouched; the tenant is what changed. Both reach the
    // caller as the same absence, which is what asking one access rule buys.
    expect(
      body<CallerResponse>(await standingOf(credential).expect(200))
        .memberships,
    ).toEqual([]);
  });

  it('stops answering a person who was deactivated, with the credential unchanged', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const member = await addMember(
      app,
      acme,
      'departed@acme.example.com',
      'admin',
    );
    const credential = await bearerFor(member.personId);
    await standingOf(credential).expect(200);

    await request(server())
      .delete(`/platform/people/${member.personId}`)
      .set(await operatorHeaders())
      .expect(204);

    // Not an empty standing — an absence. The token is still valid and still
    // verifies; the resolver refuses it because the person behind it is no
    // longer active, which is the check task 1.2 put ahead of everything else.
    await standingOf(credential).expect(404);
  });

  it('answers a session obtained the way a person actually obtains one', async () => {
    const acme = await seedTenantWithAdministrator(app, 'Acme');
    const member = await addMember(
      app,
      acme,
      'real@acme.example.com',
      'viewer',
    );
    const session = await signInThrough(
      app,
      member.personId,
      'real@acme.example.com',
      'a-password-long-enough-to-pass',
    );

    const response = await standingOf(session.headers).expect(200);

    // Requirement 4.3: the token carries `{ sub, iss, exp }` and nothing else,
    // so everything in this answer came from stored records. The signing-in
    // path is exercised rather than assumed because this is the first route a
    // client calls after it, and the whole feature exists to serve that moment.
    expect(body<CallerResponse>(response)).toEqual({
      personId: member.personId,
      email: 'real@acme.example.com',
      isOperator: false,
      memberships: [{ tenantId: acme.id, tenantName: 'Acme', role: 'viewer' }],
    });
  });
});
