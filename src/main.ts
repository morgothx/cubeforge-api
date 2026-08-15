import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DomainErrorFilter } from './adapters/http/domain-error.filter';
import { OperatorActionInterceptor } from './adapters/http/operator-action.interceptor';
import { AppModule } from './app.module';

/**
 * Express bootstrap for local development. The Lambda handler (`lambda.ts`)
 * reuses this same AppModule, so serverless stays a deployment mode rather
 * than a parallel architecture.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configure(app);
  await app.listen(process.env.PORT ?? 3000);
}

/**
 * Shared with the end-to-end tests, so what they exercise is what runs. A test
 * that assembled its own pipeline could pass while the real one is misassembled.
 */
export function configure(app: {
  useGlobalPipes: (pipe: ValidationPipe) => unknown;
  useGlobalFilters: (filter: DomainErrorFilter) => unknown;
  useGlobalInterceptors: (interceptor: OperatorActionInterceptor) => unknown;
}): void {
  app.useGlobalPipes(
    new ValidationPipe({
      // Unknown properties are rejected rather than stripped: silently ignoring
      // a field the caller believed was applied is worse than saying no.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new DomainErrorFilter());
  app.useGlobalInterceptors(new OperatorActionInterceptor());
}

if (require.main === module) {
  void bootstrap();
}
