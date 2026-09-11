import { Module } from '@nestjs/common';
import { AnalyticsQuestionsController } from './adapters/http/analytics-questions.controller';
import { AnalyticsVocabularyController } from './adapters/http/analytics-vocabulary.controller';
import { CubeClient } from './adapters/semantic/cube-client';
import { CubeModel } from './adapters/semantic/cube-model';
import { DeferredModel } from './adapters/semantic/deferred-model';
import { loadSemanticConfig } from './adapters/semantic/semantic-config';
import { SignedSecurityContext } from './adapters/semantic/security-context';
import {
  TENANT_SCOPED_MODEL,
  type TenantScopedModel,
} from './application/ports/tenant-scoped-model';
import { AskModelledQuestionUseCase } from './application/semantic/ask-modelled-question.use-case';
import { DescribeVocabularyUseCase } from './application/semantic/describe-vocabulary.use-case';

type Env = Record<string, string | undefined>;

/**
 * The seam this module binds, exported so a test can build it the way the
 * module does. A test that assembled its own would pass just as happily while
 * the module read the environment a moment too early — which is the whole
 * property the deferred build exists to hold.
 */
export function semanticSeam(env: Env): TenantScopedModel {
  return new DeferredModel(() => {
    const config = loadSemanticConfig(env);

    return new CubeModel(
      new CubeClient(config),
      new SignedSecurityContext(config),
      () => new Date(),
    );
  });
}

/**
 * The semantic surface, wired — one capability's whole binding in one file.
 *
 * **Imported by `AppModule`** for the reason `AnalyticsModule` is: this is
 * reachable by a request, so it has to be in the graph a request travels
 * through. `ExportModule` is not, because it is a command a scheduler runs.
 *
 * `PersistenceModule` is deliberately absent. Nothing here opens a database
 * transaction or holds a repository, which is requirement 5.2 in the form the
 * module system can enforce: a provider that is not imported cannot be
 * injected. The one thing on this path that does read PostgreSQL is the access
 * guard deciding whether the caller may ask — authorization rather than
 * answering, and the platform's rather than this feature's.
 *
 * Everything the semantic layer needs is read **inside** the deferred factory,
 * not around it. A `useFactory` that called `loadSemanticConfig` directly would
 * run while the graph is assembled, so an API missing one Cube setting would
 * refuse to start and take sign-in and inventory down with it — over a
 * capability those routes never touch.
 */
@Module({
  controllers: [AnalyticsQuestionsController, AnalyticsVocabularyController],
  providers: [
    {
      provide: TENANT_SCOPED_MODEL,
      useFactory: () => semanticSeam(process.env),
    },
    AskModelledQuestionUseCase,
    DescribeVocabularyUseCase,
  ],
  exports: [AskModelledQuestionUseCase],
})
export class SemanticModule {}
