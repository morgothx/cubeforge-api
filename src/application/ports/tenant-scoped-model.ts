import type { TenantId } from '../../domain/identifiers';
import type { ModelledAnswer } from '../../domain/semantic/modelled-answer';
import type { ModelledQuestion } from '../../domain/semantic/question';

export const TENANT_SCOPED_MODEL = Symbol('TENANT_SCOPED_MODEL');

/**
 * What one tenant may ask of the model.
 *
 * **No method takes a tenant**, and that absence is the isolation — the same
 * shape `TenantAnalytics` has, for the reason stated there: the tenant is bound
 * when the seam hands this object over, so "forgot to scope" is not
 * expressible rather than merely refused.
 *
 * One method where the analytical port has two, and that is the difference
 * between the two features rather than a simplification of this one. The
 * analytical port names its questions because each is a statement someone
 * wrote; this one takes a composition because the point of a model is that
 * nobody writes the combination in advance. The bound that makes that safe
 * travels *inside* `ModelledQuestion`, which is why a general interface here is
 * not the widening it would have been there.
 */
export interface ModelQuestions {
  ask(question: ModelledQuestion): Promise<ModelledAnswer>;
}

/**
 * The only way to obtain a `ModelQuestions`.
 *
 * Handed to a callback rather than injected, so there is no construction path
 * that skips the tenant — the same guarantee `TenantScopedAnalytics` and
 * `TenantScopedUnitOfWork` give, and the same reason it is a callback rather
 * than a parameter on every method.
 *
 * `askAs` refuses a tenant identifier that is not well formed **before
 * anything is signed**. Below this seam the value stops being a value: it
 * becomes a claim inside a token and a filter inside a query the model
 * composes, and there it is the one way a tenant could reach rows that are not
 * its own with every query being correct.
 */
export interface TenantScopedModel {
  askAs<T>(
    tenantId: TenantId,
    question: (model: ModelQuestions) => Promise<T>,
  ): Promise<T>;
}
