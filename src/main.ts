import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Express bootstrap for local development. The Lambda handler (`lambda.ts`)
 * reuses this same AppModule, so serverless stays a deployment mode rather
 * than a parallel architecture.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
