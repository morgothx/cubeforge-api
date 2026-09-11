import 'reflect-metadata';
import {
  apiKeyId,
  personId,
  tenantId,
  type TenantId,
} from '../../domain/identifiers';
import { describeVocabulary } from '../../domain/semantic/published-vocabulary';
import type { ActorContext } from '../actor-context';
import { ASK_MODELLED_QUESTION_ROLES } from './ask-modelled-question.use-case';
import {
  DESCRIBE_VOCABULARY_ROLES,
  DescribeVocabularyUseCase,
} from './describe-vocabulary.use-case';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const ASKER = personId('33333333-3333-4333-8333-333333333333');

const memberOf = (tenant: TenantId): ActorContext => ({
  kind: 'tenant-member',
  personId: ASKER,
  tenantId: tenant,
});

/** What `execute` threw, so its shape can be asserted rather than its text. */
function refusalOf(actor: ActorContext): unknown {
  try {
    new DescribeVocabularyUseCase().execute({ actor });
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('describing what may be asked', () => {
  it('answers a member of the tenant with the published vocabulary', () => {
    expect(
      new DescribeVocabularyUseCase().execute({ actor: memberOf(ACME) }),
    ).toEqual(describeVocabulary());
  });

  /**
   * The same callers as the questions it describes, and structurally so: one
   * list, referred to twice. A copy would agree today and drift the first time
   * somebody changed who may ask.
   */
  it('admits the roles a question admits, by the same list', () => {
    expect(DESCRIBE_VOCABULARY_ROLES).toBe(ASK_MODELLED_QUESTION_ROLES);
  });

  it('refuses a machine caller, even one issued into the tenant, as an absent record', () => {
    expect(
      refusalOf({
        kind: 'machine',
        apiKeyId: apiKeyId('44444444-4444-4444-8444-444444444444'),
        tenantId: ACME,
        role: 'admin',
      }),
    ).toMatchObject({ error: { kind: 'not-found' } });
  });

  it('refuses a person acting inside no tenant the same way', () => {
    expect(refusalOf({ kind: 'person', personId: ASKER })).toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  /**
   * Requirement 4.1 as a property of the class rather than of a test double:
   * a use case constructed from nothing has nothing that can be down. A port
   * injected later — the model, most likely, "just to check" — fails here
   * before it can make the vocabulary as fragile as the questions.
   */
  it('is built from nothing, so nothing it depends on can be unavailable', () => {
    expect(DescribeVocabularyUseCase).toHaveLength(0);
    expect(
      Reflect.getMetadata('design:paramtypes', DescribeVocabularyUseCase) ?? [],
    ).toEqual([]);
  });
});
