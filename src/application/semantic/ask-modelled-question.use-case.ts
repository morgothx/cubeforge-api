import { Inject, Injectable } from '@nestjs/common';
import { DomainViolation } from '../../domain/errors';
import type { Role } from '../../domain/membership/role';
import type { ModelledAnswer } from '../../domain/semantic/modelled-answer';
import {
  MAX_ANSWER_ROWS,
  type ModelledQuestion,
} from '../../domain/semantic/question';
import type { ActorContext } from '../actor-context';
import {
  TENANT_SCOPED_MODEL,
  type TenantScopedModel,
} from '../ports/tenant-scoped-model';
import { tenantOf } from '../tenant-authorization';

export interface ModelledQuestionQuery {
  readonly actor: ActorContext;
  /**
   * Already composed, and composed at the edge.
   *
   * The measures, the groupings and the period were validated before this ran,
   * so an unknown name or an over-long period never becomes a use case at all.
   * What arrives here is a question the platform has agreed to consider — and
   * it carries no tenant, because the type it is has nowhere to put one.
   */
  readonly question: ModelledQuestion;
}

/** Reading exported data is reading; every member of the tenant may. */
export const ASK_MODELLED_QUESTION_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies readonly Role[];

/**
 * One composed question, answered from the model.
 *
 * **A machine caller is refused on the kind of caller, not on the role.** An
 * API key is issued into a tenant with a role, so a role check would admit one
 * holding `viewer`; `tenantOf` refuses anything that is not a tenant member,
 * which is the property this needs. A modelled question is expensive, and
 * admitting keys would let an automated client decide how often that cost is
 * paid — the existing analytical route refuses machines for the same reason.
 *
 * A caller holding no active membership is answered as for a tenant that does
 * not exist, by the platform's existing rule and through no new mechanism here.
 */
@Injectable()
export class AskModelledQuestionUseCase {
  constructor(
    @Inject(TENANT_SCOPED_MODEL)
    private readonly model: TenantScopedModel,
  ) {}

  async execute(query: ModelledQuestionQuery): Promise<ModelledAnswer> {
    const tenantId = tenantOf(query.actor);

    const answer = await this.model.askAs(tenantId, (model) =>
      model.ask(query.question),
    );

    return refuseIfOverBound(answer);
  }
}

/**
 * Over the bound is a refusal, not a truncation.
 *
 * The model is asked for one row more than the bound allows, so an answer
 * carrying that many is the signal that a larger one exists. Returning the
 * first `MAX_ANSWER_ROWS` of it would be a chart that is wrong without saying
 * so — the worst of the three outcomes, because nobody looking at it has any
 * reason to doubt it.
 *
 * The bound is named in the refusal, because an operator who cannot read it off
 * the refusal will find it by bisection.
 */
function refuseIfOverBound(answer: ModelledAnswer): ModelledAnswer {
  if (answer.state === 'answered' && answer.rows.length > MAX_ANSWER_ROWS) {
    throw new DomainViolation({
      kind: 'validation',
      field: 'question',
      detail:
        `would answer with more than ${MAX_ANSWER_ROWS} rows; ` +
        'narrow the period or ask for fewer groupings',
    });
  }

  return answer;
}
