import { AnalyticsUnavailable } from './application/analytics/analytics-failure';
import type { ModelQuestions } from './application/ports/tenant-scoped-model';
import { day, periodFrom } from './domain/analytics/period';
import { tenantId } from './domain/identifiers';
import { questionFrom } from './domain/semantic/question';
import { semanticSeam } from './semantic.module';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');

const CONFIGURED = {
  CUBE_URL: 'http://cube:4000',
  CUBEJS_API_SECRET: 'a-secret-of-at-least-thirty-two-characters',
  AUTH_TOKEN_SECRET: 'a-different-platform-secret-of-32-chars',
};

const aQuestion = questionFrom({
  measures: ['net_quantity'],
  groupings: [],
  period: periodFrom(day('2026-03-01'), day('2026-03-31')),
  by: 'recorded',
});

const ask = (seam: ReturnType<typeof semanticSeam>) =>
  seam.askAs(ACME, (model: ModelQuestions) => model.ask(aQuestion));

/**
 * The seam the module binds, built the way the module builds it.
 *
 * A test that assembled its own would pass just as happily while the module
 * read the environment a moment too early — and reading it too early is the one
 * failure this arrangement exists to prevent. The application overrides this
 * token in every route test, so nothing else exercises it.
 */
describe('the seam the semantic module binds', () => {
  it('is built with nothing configured, because a boot must not depend on it', () => {
    expect(() => semanticSeam({})).not.toThrow();
  });

  it('refuses a question when the settings are missing, naming no setting', async () => {
    const refusal: unknown = await ask(semanticSeam({})).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(AnalyticsUnavailable);
    expect((refusal as AnalyticsUnavailable).reason).toBe('not-configured');
    expect((refusal as AnalyticsUnavailable).message).not.toContain('CUBE_URL');
  });

  it('names every missing setting in the cause, which only a log reads', async () => {
    const refusal = (await ask(semanticSeam({})).catch(
      (error: unknown) => error,
    )) as AnalyticsUnavailable;

    expect((refusal.cause as Error).message).toContain('CUBE_URL');
    expect((refusal.cause as Error).message).toContain('CUBEJS_API_SECRET');
  });

  it('takes a setting supplied later without a restart', async () => {
    const env: Record<string, string | undefined> = {};
    const seam = semanticSeam(env);

    await expect(ask(seam)).rejects.toBeInstanceOf(AnalyticsUnavailable);

    Object.assign(env, CONFIGURED);

    // It builds now. Reaching the model is a different failure, and the point
    // is that construction no longer refuses.
    const outcome: unknown = await ask(seam).catch((error: unknown) => error);
    expect((outcome as AnalyticsUnavailable).reason).not.toBe('not-configured');
  });

  it('builds once the settings are there', () => {
    const seam = semanticSeam(CONFIGURED);

    expect(typeof seam.askAs).toBe('function');
  });
});
