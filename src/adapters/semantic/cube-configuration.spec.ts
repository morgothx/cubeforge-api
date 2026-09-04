import { createRequire } from 'node:module';

import { requireLocalEmulator } from '../aws/require-local-emulator';

/**
 * The configuration the container reads, loaded here.
 *
 * `cube/` is outside the TypeScript project, so nothing type-checks it and an
 * `import` would drag it into the build graph. A runtime `require` keeps it
 * out while still running the real file — and this spec lives under `src/`
 * rather than beside it because Jest's `rootDir` is `src`, so a spec anywhere
 * else is never collected. A test that cannot run is worse than an absent one,
 * because it looks like coverage.
 */
interface CubeConfiguration {
  requireLocalEmulator(endpoint: string, setting: string): void;
  engineAddress(env?: Record<string, string | undefined>): string;
  driverOptions(env?: Record<string, string | undefined>): {
    endpoint: string;
  };
}

/**
 * `createRequire` rather than a bare `require`, which the lint rules forbid.
 *
 * The mechanism is the point and not an accident: an `import` would pull a file
 * outside the TypeScript project into the build graph, and this loads the real
 * file the container loads without doing that.
 */
const configuration = createRequire(__filename)(
  '../../../cube/configuration.js',
) as CubeConfiguration;

const NOT_THE_EMULATOR = [
  'https://athena.us-east-1.amazonaws.com',
  'http://athena.internal.example.com',
  'https://169.254.169.254',
];

describe('the configuration the container reads', () => {
  it('hands the driver the engine address, under the key the driver forwards', () => {
    expect(
      configuration.driverOptions({
        CUBE_ATHENA_ENDPOINT: 'http://floci:4566',
      }),
    ).toEqual({ endpoint: 'http://floci:4566' });
  });

  it('carries the endpoint and nothing else, so it holds no credential', () => {
    const options = configuration.driverOptions({
      CUBE_ATHENA_ENDPOINT: 'http://localhost:4566',
      AWS_SECRET_ACCESS_KEY: 'must-not-travel',
    });

    expect(Object.keys(options)).toEqual(['endpoint']);
    expect(JSON.stringify(options)).not.toContain('must-not-travel');
  });

  it('falls back to the compose name when nothing is configured', () => {
    expect(configuration.engineAddress({})).toBe('http://floci:4566');
  });

  it('refuses an address that is not the emulator, naming what it got', () => {
    for (const address of NOT_THE_EMULATOR) {
      expect(() =>
        configuration.engineAddress({ CUBE_ATHENA_ENDPOINT: address }),
      ).toThrow('local emulator');
    }
  });

  it('refuses a value that is not a URL at all', () => {
    expect(() =>
      configuration.engineAddress({ CUBE_ATHENA_ENDPOINT: 'not a url' }),
    ).toThrow('not a URL');
  });

  /**
   * A host and port with no scheme parses, and is refused for the other reason.
   *
   * `new URL('floci:4566')` succeeds with protocol `floci:` and an empty host,
   * so it never reaches the "not a URL" refusal — it is caught by the emulator
   * check instead, because the empty string is not a permitted host. Pinned
   * because the near-miss looks correct at a glance, and because the semantic
   * configuration loader hit the same trap with `cube:4000`.
   */
  it('refuses a host and port written without a scheme', () => {
    expect(() =>
      configuration.engineAddress({ CUBE_ATHENA_ENDPOINT: 'floci:4566' }),
    ).toThrow('local emulator');
  });

  /**
   * The two copies of the refusal are driven over the same hosts.
   *
   * `cube/configuration.js` cannot import the TypeScript one — it is outside
   * the project — so the rule exists twice, and two copies of a refusal are two
   * chances for one of them to be relaxed. This is what makes that mechanical
   * rather than a matter of somebody remembering.
   */
  it('agrees with the refusal the adapters apply, host for host', () => {
    const candidates = [
      'http://localhost:4566',
      'http://127.0.0.1:4566',
      'http://[::1]:4566',
      'http://floci:4566',
      'https://athena.us-east-1.amazonaws.com',
      'http://s3.example.com',
      'not a url',
      '',
    ];

    const verdicts = (refuse: (address: string) => void) =>
      candidates.map((address) => {
        try {
          refuse(address);
          return 'accepted';
        } catch {
          return 'refused';
        }
      });

    expect(
      verdicts((address) =>
        configuration.requireLocalEmulator(address, 'CUBE_ATHENA_ENDPOINT'),
      ),
    ).toEqual(
      verdicts((address) =>
        requireLocalEmulator(address, 'CUBE_ATHENA_ENDPOINT'),
      ),
    );
  });
});
