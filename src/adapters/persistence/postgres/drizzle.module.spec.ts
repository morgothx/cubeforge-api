import { Test } from '@nestjs/testing';
import {
  APP_DATABASE,
  DrizzleModule,
  OPERATOR_DATABASE,
} from './drizzle.module';

const complete: Record<string, string> = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_DB: 'cubeforge',
  POSTGRES_MIGRATOR_USER: 'cubeforge_migrator',
  POSTGRES_MIGRATOR_PASSWORD: 'migrator-secret',
  POSTGRES_APP_USER: 'cubeforge_app',
  POSTGRES_APP_PASSWORD: 'app-secret',
  POSTGRES_OPERATOR_USER: 'cubeforge_operator',
  POSTGRES_OPERATOR_PASSWORD: 'operator-secret',
};

describe('DrizzleModule', () => {
  const original = process.env;

  afterEach(() => {
    process.env = original;
  });

  const withEnv = (env: Record<string, string>) => {
    process.env = { ...original, ...env };
    return Test.createTestingModule({ imports: [DrizzleModule] }).compile();
  };

  it('refuses to start and names the missing setting', async () => {
    const { POSTGRES_APP_PASSWORD, ...partial } = complete;
    expect(POSTGRES_APP_PASSWORD).toBeDefined();
    process.env = { ...original, POSTGRES_APP_PASSWORD: undefined };

    await expect(withEnv(partial)).rejects.toThrow(/POSTGRES_APP_PASSWORD/);
  });

  it('starts and exposes a separate handle per runtime identity', async () => {
    const moduleRef = await withEnv(complete);

    expect(moduleRef.get(APP_DATABASE)).toBeDefined();
    expect(moduleRef.get(OPERATOR_DATABASE)).toBeDefined();
    expect(moduleRef.get(APP_DATABASE)).not.toBe(
      moduleRef.get(OPERATOR_DATABASE),
    );

    await moduleRef.close();
  });
});
