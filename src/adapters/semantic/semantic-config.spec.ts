import { loadSemanticConfig } from './semantic-config';

describe('reading where the semantic layer is', () => {
  const platformSecret = 'local-development-only-signing-secret-change-me';
  const modelSecret = 'a-different-dev-only-secret-of-sufficient-length';

  const complete = {
    CUBE_URL: 'http://cube:4000',
    CUBEJS_API_SECRET: modelSecret,
    AUTH_TOKEN_SECRET: platformSecret,
  };

  it('reads the address, the secret and a deadline', () => {
    expect(
      loadSemanticConfig({ ...complete, CUBE_QUESTION_TIMEOUT_MS: '5000' }),
    ).toEqual({
      url: 'http://cube:4000',
      secret: modelSecret,
      questionTimeoutMs: 5000,
    });
  });

  it('names every missing setting at once', () => {
    // A configuration reported one key per attempt is a configuration fixed one
    // attempt per afternoon. The same rule the analytics loader follows.
    expect(() =>
      loadSemanticConfig({ AUTH_TOKEN_SECRET: platformSecret }),
    ).toThrow(/CUBE_URL.*CUBEJS_API_SECRET|CUBEJS_API_SECRET.*CUBE_URL/s);
  });

  it('refuses a secret the platform already signs with', () => {
    // Sharing one secret would let a platform access token be presented to the
    // semantic layer directly, which is precisely what requirement 4.2 forbids
    // — and both would verify, so the failure would be silent.
    expect(() =>
      loadSemanticConfig({ ...complete, CUBEJS_API_SECRET: platformSecret }),
    ).toThrow(/CUBEJS_API_SECRET.*AUTH_TOKEN_SECRET/s);
  });

  it('refuses a secret weaker than the one it must not equal', () => {
    expect(() =>
      loadSemanticConfig({ ...complete, CUBEJS_API_SECRET: 'too-short' }),
    ).toThrow(/CUBEJS_API_SECRET.*32/s);
  });

  it('refuses an address that is not one', () => {
    // "cube:4000" parses as a URL with the scheme "cube:", which is how a
    // host-and-port typed without a scheme reaches a client as something it
    // cannot dial. The refusal names the setting rather than leaving the
    // failure to arrive later wearing a driver's wording.
    for (const url of ['cube:4000', 'not a url', 'ftp://cube:4000']) {
      expect(() => loadSemanticConfig({ ...complete, CUBE_URL: url })).toThrow(
        /CUBE_URL/,
      );
    }
  });

  it('defaults the deadline, and refuses one that is not a count of milliseconds', () => {
    expect(loadSemanticConfig(complete).questionTimeoutMs).toBeGreaterThan(0);

    for (const raw of ['0', '-1', 'soon', '1.5']) {
      expect(() =>
        loadSemanticConfig({ ...complete, CUBE_QUESTION_TIMEOUT_MS: raw }),
      ).toThrow(/CUBE_QUESTION_TIMEOUT_MS/);
    }
  });

  it('ignores the surrounding whitespace of a value', () => {
    expect(
      loadSemanticConfig({ ...complete, CUBE_URL: '  http://cube:4000  ' }).url,
    ).toBe('http://cube:4000');
  });
});
