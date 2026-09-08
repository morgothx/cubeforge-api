import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import type {
  ModelQuestions,
  TenantScopedModel,
} from '../../application/ports/tenant-scoped-model';
import { day, periodFrom } from '../../domain/analytics/period';
import { tenantId, type TenantId } from '../../domain/identifiers';
import { neverExported } from '../../domain/semantic/modelled-answer';
import { questionFrom } from '../../domain/semantic/question';
import { DeferredModel } from './deferred-model';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');

const aQuestion = questionFrom({
  measures: ['net_quantity'],
  groupings: [],
  period: periodFrom(day('2026-03-01'), day('2026-03-31')),
  by: 'recorded',
});

/** Stands in for whatever the factory would have built. */
function reachable(): TenantScopedModel & { asked: number } {
  const model = {
    asked: 0,
    askAs<T>(
      _tenantId: TenantId,
      question: (model: ModelQuestions) => Promise<T>,
    ): Promise<T> {
      model.asked += 1;
      return question({ ask: () => Promise.resolve(neverExported()) });
    },
  };
  return model;
}

const ask = (deferred: TenantScopedModel) =>
  deferred.askAs(ACME, (model: ModelQuestions) => model.ask(aQuestion));

describe('building the model at the first question', () => {
  it('builds nothing while nobody is asking', () => {
    let built = 0;

    new DeferredModel(() => {
      built += 1;
      return reachable();
    });

    expect(built).toBe(0);
  });

  it('builds once, however many questions arrive', async () => {
    let built = 0;
    const deferred = new DeferredModel(() => {
      built += 1;
      return reachable();
    });

    await ask(deferred);
    await ask(deferred);
    await ask(deferred);

    expect(built).toBe(1);
  });

  it('answers through whatever it built', async () => {
    const model = reachable();

    await expect(ask(new DeferredModel(() => model))).resolves.toEqual({
      state: 'never-exported',
    });
    expect(model.asked).toBe(1);
  });

  /**
   * A missing setting refuses a modelled question, not a boot.
   *
   * A provider factory reading the environment would run while the application
   * graph is assembled, so an API missing one semantic setting would refuse to
   * start and take sign-in and inventory down with it — over a capability those
   * routes never touch.
   */
  it('turns a missing setting into a refusal to answer, not a refusal to start', async () => {
    const deferred = new DeferredModel(() => {
      throw new Error('missing configuration: CUBE_URL');
    });

    // Constructing it is not what fails.
    expect(deferred).toBeInstanceOf(DeferredModel);

    const refusal: unknown = await ask(deferred).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(AnalyticsUnavailable);
    expect((refusal as AnalyticsUnavailable).reason).toBe('not-configured');
  });

  it('keeps the missing settings out of what it reports', async () => {
    const deferred = new DeferredModel(() => {
      throw new Error('missing configuration: CUBE_URL, CUBEJS_API_SECRET');
    });

    const refusal = (await ask(deferred).catch(
      (error: unknown) => error,
    )) as AnalyticsUnavailable;

    expect(refusal.message).not.toContain('CUBE_URL');
    // The cause is what a log reads, and it is the only place this appears.
    expect((refusal.cause as Error).message).toContain('CUBE_URL');
  });

  /**
   * Nothing caches a refusal, so a setting supplied to a running process takes
   * effect at the next question rather than at the next deployment.
   */
  it('tries again after a failure, so a corrected setting needs no restart', async () => {
    let configured = false;
    const model = reachable();

    const deferred = new DeferredModel(() => {
      if (!configured) {
        throw new Error('missing configuration: CUBE_URL');
      }
      return model;
    });

    await expect(ask(deferred)).rejects.toBeInstanceOf(AnalyticsUnavailable);

    configured = true;

    await expect(ask(deferred)).resolves.toEqual({ state: 'never-exported' });
  });

  it('refuses as a rejection, never as a synchronous throw', () => {
    const deferred = new DeferredModel(() => {
      throw new Error('missing configuration: CUBE_URL');
    });

    // The port promises one shape of failure. A caller reaching for `.catch`
    // without awaiting would miss the other.
    expect(() => void ask(deferred).catch(() => undefined)).not.toThrow();
  });

  it('is a TenantScopedModel, so nothing downstream knows it is deferred', () => {
    const deferred: TenantScopedModel = new DeferredModel(reachable);

    expect(typeof deferred.askAs).toBe('function');
  });
});
