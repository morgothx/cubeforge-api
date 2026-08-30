import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import type { TenantScopedAnalytics } from '../../application/ports/tenant-scoped-analytics';
import { tenantId } from '../../domain/identifiers';
import { DeferredAnalytics } from './deferred-analytics';
import { InMemoryAnalytics } from './in-memory-analytics';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');

describe('reading the analytical configuration at the first question', () => {
  it('builds nothing while nobody is asking', () => {
    let built = 0;

    new DeferredAnalytics(() => {
      built += 1;
      return new InMemoryAnalytics();
    });

    expect(built).toBe(0);
  });

  it('builds once, however many questions arrive', async () => {
    let built = 0;
    const deferred = new DeferredAnalytics(() => {
      built += 1;
      return new InMemoryAnalytics();
    });

    await deferred.askAs(ACME, () => Promise.resolve('first'));
    await deferred.askAs(ACME, () => Promise.resolve('second'));

    expect(built).toBe(1);
  });

  it('answers through whatever it built', async () => {
    const real = new InMemoryAnalytics();
    real.carried(ACME, new Date('2026-08-29T03:00:00.000Z'), {
      stock: [{ sku: 'ACME-001', name: 'A widget', onHand: 8 }],
    });
    const deferred = new DeferredAnalytics(() => real);

    const answer = await deferred.askAs(ACME, (tenant) => tenant.stockOnHand());

    expect(answer.state).toBe('answered');
  });

  /**
   * The requirement is that the analytics refuses to *answer* (7.1). An API
   * that refused to *boot* over a setting one route uses would take every other
   * route down with it — so the refusal has to arrive here, on the question.
   */
  it('turns a missing setting into a refusal to answer, not a refusal to start', async () => {
    const deferred = new DeferredAnalytics(() => {
      throw new Error('missing analytics configuration: ANALYTICS_DATABASE');
    });

    await expect(
      deferred.askAs(ACME, () => Promise.resolve('never reached')),
    ).rejects.toBeInstanceOf(AnalyticsUnavailable);
    await expect(
      deferred.askAs(ACME, () => Promise.resolve('never reached')),
    ).rejects.toMatchObject({ reason: 'not-configured' });
  });

  it('keeps the missing settings out of what it reports', async () => {
    const deferred = new DeferredAnalytics(() => {
      throw new Error('missing analytics configuration: ANALYTICS_DATABASE');
    });

    const refusal = await deferred
      .askAs<string>(ACME, () => Promise.resolve('never reached'))
      .then(() => {
        throw new Error(
          'the question was answered, so there is nothing to read',
        );
      })
      .catch((error: unknown) => error as AnalyticsUnavailable);

    expect(refusal.message).not.toContain('ANALYTICS_DATABASE');
    // The operator still needs it, so it travels as the cause.
    expect((refusal.cause as Error).message).toContain('ANALYTICS_DATABASE');
  });

  it('tries again after a failure, so a corrected setting needs no restart', async () => {
    let attempts = 0;
    const deferred = new DeferredAnalytics(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('missing analytics configuration: ANALYTICS_DATABASE');
      }
      return new InMemoryAnalytics();
    });

    await expect(
      deferred.askAs(ACME, () => Promise.resolve('one')),
    ).rejects.toBeInstanceOf(AnalyticsUnavailable);

    await expect(
      deferred.askAs(ACME, () => Promise.resolve('two')),
    ).resolves.toBe('two');
  });

  it('is a TenantScopedAnalytics, so nothing downstream knows it is deferred', () => {
    const port: TenantScopedAnalytics = new DeferredAnalytics(
      () => new InMemoryAnalytics(),
    );

    expect(typeof port.askAs).toBe('function');
  });
});
