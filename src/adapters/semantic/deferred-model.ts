import { AnalyticsUnavailable } from '../../application/analytics/analytics-failure';
import type {
  ModelQuestions,
  TenantScopedModel,
} from '../../application/ports/tenant-scoped-model';
import type { TenantId } from '../../domain/identifiers';

/**
 * The model, built at the first question rather than when the module is.
 *
 * Requirement 8.1 says the semantic layer refuses to **answer** when its
 * configuration is missing, and the distinction is the whole reason this class
 * exists: a provider factory reading the environment would run while the
 * application graph is assembled, so an API missing one semantic setting would
 * refuse to start and take sign-in, inventory and everything else down with it
 * — over a capability those routes never touch.
 *
 * The same shape as `DeferredAnalytics` and for the same reason stated there.
 * Two classes rather than one generic: what they defer are different ports with
 * different methods, and a shared base parameterised over both would exist to
 * save a dozen lines while making each one harder to read on its own.
 *
 * The failure it produces is `not-configured`, which names an operator's next
 * action. What is missing travels as the cause, so it reaches a log and no
 * response — env keys are not a secret, but a message a caller can read is a
 * message that describes this platform's insides to whoever asks.
 *
 * A failed build is **not** remembered. Nothing here caches a refusal, so a
 * setting supplied to a running process takes effect at the next question
 * rather than at the next deployment.
 */
export class DeferredModel implements TenantScopedModel {
  private built: TenantScopedModel | null = null;

  constructor(private readonly build: () => TenantScopedModel) {}

  async askAs<T>(
    tenantId: TenantId,
    question: (model: ModelQuestions) => Promise<T>,
  ): Promise<T> {
    return (await this.ready()).askAs(tenantId, question);
  }

  private ready(): Promise<TenantScopedModel> {
    if (this.built !== null) {
      return Promise.resolve(this.built);
    }

    try {
      this.built = this.build();
    } catch (error) {
      // `async` above, so this is a rejection rather than a synchronous throw.
      // The port promises one shape of failure and this is the only place that
      // could have delivered two.
      throw new AnalyticsUnavailable('not-configured', error);
    }

    return Promise.resolve(this.built);
  }
}
