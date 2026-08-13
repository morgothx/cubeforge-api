import { loadDatabaseConfig } from './database-config';

const complete = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_DB: 'cubeforge',
  POSTGRES_MIGRATOR_USER: 'cubeforge_migrator',
  POSTGRES_MIGRATOR_PASSWORD: 'migrator-secret',
  POSTGRES_APP_USER: 'cubeforge_app',
  POSTGRES_APP_PASSWORD: 'app-secret',
  POSTGRES_OPERATOR_USER: 'cubeforge_operator',
  POSTGRES_OPERATOR_PASSWORD: 'operator-secret',
  POSTGRES_AUTHENTICATOR_USER: 'cubeforge_authenticator',
  POSTGRES_AUTHENTICATOR_PASSWORD: 'authenticator-secret',
};

describe('loadDatabaseConfig', () => {
  it('reads a separate identity for migrations, tenant work and operator work', () => {
    const config = loadDatabaseConfig(complete);

    expect(config.host).toBe('localhost');
    expect(config.port).toBe(5432);
    expect(config.database).toBe('cubeforge');
    expect(config.migrator.user).toBe('cubeforge_migrator');
    expect(config.app.user).toBe('cubeforge_app');
    expect(config.operator.user).toBe('cubeforge_operator');
    expect(config.authenticator.user).toBe('cubeforge_authenticator');
  });

  it('refuses to point the authenticating identity at the schema owner', () => {
    expect(() =>
      loadDatabaseConfig({
        ...complete,
        POSTGRES_AUTHENTICATOR_USER: complete.POSTGRES_MIGRATOR_USER,
      }),
    ).toThrow(/POSTGRES_AUTHENTICATOR_USER.*owner/s);
  });

  it('names every missing setting at once rather than one per restart', () => {
    const { POSTGRES_APP_USER, POSTGRES_OPERATOR_PASSWORD, ...partial } =
      complete;
    expect(POSTGRES_APP_USER).toBeDefined();
    expect(POSTGRES_OPERATOR_PASSWORD).toBeDefined();

    expect(() => loadDatabaseConfig(partial)).toThrow(
      /POSTGRES_APP_USER.*POSTGRES_OPERATOR_PASSWORD|POSTGRES_OPERATOR_PASSWORD.*POSTGRES_APP_USER/s,
    );
  });

  it('treats a blank setting as missing', () => {
    expect(() =>
      loadDatabaseConfig({ ...complete, POSTGRES_DB: '   ' }),
    ).toThrow(/POSTGRES_DB/);
  });

  it('rejects a port that is not a number', () => {
    expect(() =>
      loadDatabaseConfig({ ...complete, POSTGRES_PORT: 'not-a-port' }),
    ).toThrow(/POSTGRES_PORT/);
  });

  it('refuses to let the application run as the schema owner', () => {
    expect(() =>
      loadDatabaseConfig({
        ...complete,
        POSTGRES_APP_USER: complete.POSTGRES_MIGRATOR_USER,
      }),
    ).toThrow(/owner|migrator/i);
  });
});
