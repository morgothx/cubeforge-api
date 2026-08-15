import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Access } from '../../src/adapters/http/access/access.decorator';
import { AccessGuard } from '../../src/adapters/http/access/access.guard';
import { attachActor } from '../../src/adapters/http/principal.middleware';
import { PostgresTenantScopedUnitOfWork } from '../../src/adapters/persistence/postgres/postgres-tenant-scoped-unit-of-work';
import {
  personId as toPersonId,
  tenantId as toTenantId,
} from '../../src/domain/identifiers';
import { runtimePool } from './support/database';
import {
  seedMember,
  seedTenant,
  useIntegrationDatabase,
} from './support/fixtures';

/**
 * What the guard's own transaction costs, measured rather than assumed.
 *
 * The design chose to let the guard open a transaction of its own rather than
 * share the one the use case owns, and recorded that the price was a second
 * read of the same three rows. This is where that price stops being a claim.
 * If the figure is bad, the transaction decision is the one to revisit, and it
 * is isolated to this one component.
 *
 * The guard is driven directly instead of through a route, because it is not
 * registered in the application until task 4.5 and the work being measured is
 * the same either way: one `runInTenant`, three indexed single-row reads, and
 * the access decision.
 */
describe('what the access guard costs', () => {
  useIntegrationDatabase();

  /** Enough to average out a cold connection and the odd scheduler hiccup. */
  const ITERATIONS = 50;

  class Routes {
    @Access({ roles: ['admin'] })
    resolves(this: void): void {}

    @Access({ public: true })
    shortCircuits(this: void): void {}
  }

  it('resolves a membership in a few milliseconds, and says so out loud', async () => {
    const tenant = await seedTenant({ name: 'Acme' });
    const member = await seedMember({ tenantId: tenant.id, role: 'admin' });

    const guard = new AccessGuard(
      new Reflector(),
      new PostgresTenantScopedUnitOfWork(drizzle(runtimePool('app'))),
    );

    const request = {} as Parameters<typeof attachActor>[0];
    attachActor(request, {
      kind: 'tenant-member',
      personId: toPersonId(member.personId),
      tenantId: toTenantId(tenant.id),
    });

    const contextFor = (handler: () => void): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => Routes,
        switchToHttp: () => ({ getRequest: () => request }),
      }) as unknown as ExecutionContext;

    const resolving = contextFor(Routes.prototype.resolves);
    const shortCircuiting = contextFor(Routes.prototype.shortCircuits);

    // One of each first: a cold pool connection would otherwise land entirely
    // on whichever measurement ran first.
    await guard.canActivate(resolving);
    await guard.canActivate(shortCircuiting);

    const time = async (context: ExecutionContext): Promise<number> => {
      const started = performance.now();
      for (let run = 0; run < ITERATIONS; run += 1) {
        await guard.canActivate(context);
      }
      return (performance.now() - started) / ITERATIONS;
    };

    const withResolution = await time(resolving);
    const withoutResolution = await time(shortCircuiting);

    // The transaction on its own, doing nothing inside it. Without this the
    // total says how expensive the guard is and not *why*, and the two answers
    // point at different fixes: fewer reads, or fewer transactions.
    const unitOfWork = new PostgresTenantScopedUnitOfWork(
      drizzle(runtimePool('app')),
    );
    const emptyStarted = performance.now();
    for (let run = 0; run < ITERATIONS; run += 1) {
      await unitOfWork.runInTenant(toTenantId(tenant.id), () =>
        Promise.resolve(),
      );
    }
    const emptyTransaction = (performance.now() - emptyStarted) / ITERATIONS;

    process.stdout.write(
      `\n  guard resolving a membership: ${withResolution.toFixed(2)} ms/request` +
        `\n  guard short-circuiting:      ${withoutResolution.toFixed(2)} ms/request` +
        `\n  empty transaction alone:     ${emptyTransaction.toFixed(2)} ms/request` +
        `\n  the three reads:             ${(withResolution - emptyTransaction).toFixed(2)} ms/request\n`,
    );

    // A ceiling generous enough never to fail on a busy laptop, and tight
    // enough to catch the failures worth catching: a lost index, a resolution
    // that started issuing a query per membership, a transaction left open.
    // The figure this run produced belongs in the Implementation Notes; this
    // assertion only guards the order of magnitude.
    expect(withResolution).toBeLessThan(50);
    expect(withoutResolution).toBeLessThan(withResolution);
  });
});
