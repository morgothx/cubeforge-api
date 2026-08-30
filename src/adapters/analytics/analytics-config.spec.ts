import { loadAnalyticsConfig } from './analytics-config';

const COMPLETE = {
  ANALYTICS_DATABASE: 'cubeforge',
  ANALYTICS_WORKGROUP: 'primary',
  ANALYTICS_RESULTS_LOCATION: 's3://cubeforge-analytics-results/',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

/**
 * Where the questions go, validated before one is asked.
 *
 * Read once rather than at the first question, for the reason the export
 * settled: half-way through is exactly where a missing setting hurts. What is
 * different here is that the reading happens at the first question rather than
 * at startup — an API that refused to boot over a setting one route uses would
 * take every other route down with it.
 */
describe('the analytical destination', () => {
  it('reads the whole destination from the environment', () => {
    expect(loadAnalyticsConfig(COMPLETE)).toEqual({
      database: 'cubeforge',
      workgroup: 'primary',
      resultsLocation: 's3://cubeforge-analytics-results/',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('names the missing catalogue rather than failing at the first question', () => {
    expect(() =>
      loadAnalyticsConfig({ ...COMPLETE, ANALYTICS_DATABASE: undefined }),
    ).toThrow('ANALYTICS_DATABASE');
  });

  it('names every missing setting at once', () => {
    // A configuration reported one key per attempt is a configuration fixed one
    // attempt per afternoon.
    expect(() => loadAnalyticsConfig({})).toThrow(
      'ANALYTICS_DATABASE, ANALYTICS_WORKGROUP, ANALYTICS_RESULTS_LOCATION, AWS_ENDPOINT_URL, AWS_DEFAULT_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY',
    );
  });

  it('treats blank as missing, because a blank catalogue is not a catalogue', () => {
    expect(() =>
      loadAnalyticsConfig({ ...COMPLETE, ANALYTICS_WORKGROUP: '   ' }),
    ).toThrow('ANALYTICS_WORKGROUP');
  });

  it('refuses an endpoint that is not the local emulator', () => {
    expect(() =>
      loadAnalyticsConfig({
        ...COMPLETE,
        AWS_ENDPOINT_URL: 'https://athena.us-east-1.amazonaws.com',
      }),
    ).toThrow('local emulator');
  });

  it('refuses a results location that is not somewhere objects can be put', () => {
    // The engine writes there itself. A value that is not an object-store
    // location fails at the first question with the engine's wording rather
    // than here with the setting's name.
    expect(() =>
      loadAnalyticsConfig({
        ...COMPLETE,
        ANALYTICS_RESULTS_LOCATION: '/tmp/results',
      }),
    ).toThrow('ANALYTICS_RESULTS_LOCATION');
  });
});
