import { AnalyticsUnavailable } from './application/analytics/analytics-failure';
import { tenantId } from './domain/identifiers';
import { analyticsSeam } from './analytics.module';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');

/**
 * The API must start with no analytical configuration present at all.
 *
 * `AnalyticsModule` is imported by `AppModule`, so anything it reads while the
 * graph is assembled is read on every boot — and an API that refused to start
 * over `ANALYTICS_DATABASE` would take sign-in, inventory and the rest down
 * with it, for a capability none of them touch. Requirement 7.1 asks the
 * analytics to refuse to *answer*, and this is the difference between the two.
 *
 * The export module is the deliberate opposite and is right to be: it is a
 * command, nothing else is running, and refusing early costs nobody anything.
 */
describe('binding the analytical seam', () => {
  it('reads no configuration while the module is being built', () => {
    expect(() => analyticsSeam({})).not.toThrow();
  });

  it('refuses the question instead, naming a class an operator can act on', async () => {
    const seam = analyticsSeam({});

    const refusal = await seam
      .askAs(ACME, () => Promise.resolve('never reached'))
      .then(() => null)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(AnalyticsUnavailable);
    expect((refusal as AnalyticsUnavailable).reason).toBe('not-configured');
  });

  it('names every missing setting to the operator, and none to the caller', async () => {
    const seam = analyticsSeam({});

    const refusal = (await seam
      .askAs(ACME, () => Promise.resolve('never reached'))
      .then(() => null)
      .catch((error: unknown) => error)) as AnalyticsUnavailable;

    expect((refusal.cause as Error).message).toContain('ANALYTICS_DATABASE');
    expect((refusal.cause as Error).message).toContain('ANALYTICS_WORKGROUP');
    expect((refusal.cause as Error).message).toContain(
      'ANALYTICS_RESULTS_LOCATION',
    );
    expect(refusal.message).not.toContain('ANALYTICS_');
  });
});
