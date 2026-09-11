import { Injectable } from '@nestjs/common';
import {
  describeVocabulary,
  type PublishedVocabulary,
} from '../../domain/semantic/published-vocabulary';
import type { ActorContext } from '../actor-context';
import { tenantOf } from '../tenant-authorization';
import { ASK_MODELLED_QUESTION_ROLES } from './ask-modelled-question.use-case';

/**
 * The same callers as the questions this describes — the same list, referred to
 * again rather than written twice. Describing what may be asked to somebody who
 * may not ask would disclose nothing, but it would be a second admission rule
 * for one capability, and the two would drift the first time either changed.
 */
export const DESCRIBE_VOCABULARY_ROLES = ASK_MODELLED_QUESTION_ROLES;

export interface DescribeVocabularyQuery {
  readonly actor: ActorContext;
}

/**
 * What may be asked, for a caller who may ask.
 *
 * **Built from nothing.** There is no port here and no constructor parameter:
 * the vocabulary is a domain value, so a semantic layer that is down, a store
 * that is unreachable or a setting nobody supplied cannot reach this route. The
 * questions it describes can fail; learning what to ask cannot.
 *
 * **`tenantOf` runs for its refusal, not its result.** The vocabulary is the
 * same in every tenant, so the tenant it returns is discarded. What the call
 * contributes is the platform's existing rule: anything that is not a tenant
 * member — a machine credential, even one issued into this tenant, or a person
 * acting in no tenant — is answered as an absent record. Whether a person holds
 * an active membership here was already decided by the access guard, before
 * this ran, which is where that check lives for the questions too.
 */
@Injectable()
export class DescribeVocabularyUseCase {
  execute(query: DescribeVocabularyQuery): PublishedVocabulary {
    tenantOf(query.actor);

    return describeVocabulary();
  }
}
