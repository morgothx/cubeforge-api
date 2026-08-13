import { personId } from '../../domain/identifiers';
import { JwtAccessTokenIssuer, loadTokenConfig } from './access-token-issuer';

const SECRET = 'a-local-development-signing-secret-of-sufficient-length';
const ISSUED_AT = new Date('2026-01-01T00:00:00.000Z');

describe('signing and verifying access tokens', () => {
  const issuer = new JwtAccessTokenIssuer({
    secret: SECRET,
    accessTokenLifetimeSeconds: 900,
  });
  const subject = personId('018f2c00-0000-7000-8000-0000000000f1');

  it('round-trips the person it was issued for', async () => {
    const token = await issuer.issue(subject, ISSUED_AT);

    await expect(issuer.verify(token, ISSUED_AT)).resolves.toBe(subject);
  });

  it('expires within the configured lifetime', async () => {
    const token = await issuer.issue(subject, ISSUED_AT);

    const justBefore = new Date(ISSUED_AT.getTime() + 899_000);
    const justAfter = new Date(ISSUED_AT.getTime() + 901_000);

    await expect(issuer.verify(token, justBefore)).resolves.toBe(subject);
    await expect(issuer.verify(token, justAfter)).resolves.toBeNull();
  });

  /**
   * Requirement 3.4 wants every failure to be one failure. Returning null
   * rather than throwing per cause is what makes that true at the type level:
   * there is no variant for a caller to branch on.
   */
  it('reports every kind of unusable token the same way', async () => {
    const foreign = new JwtAccessTokenIssuer({
      secret: 'a-completely-different-signing-secret-of-good-length',
      accessTokenLifetimeSeconds: 900,
    });
    const signedElsewhere = await foreign.issue(subject, ISSUED_AT);

    await expect(issuer.verify(signedElsewhere, ISSUED_AT)).resolves.toBeNull();
    await expect(issuer.verify('not-a-token', ISSUED_AT)).resolves.toBeNull();
    await expect(issuer.verify('', ISSUED_AT)).resolves.toBeNull();
    await expect(issuer.verify('aaa.bbb.ccc', ISSUED_AT)).resolves.toBeNull();
  });

  /** Requirement 3.1 and 3.5: the person, and deliberately nothing else. */
  it('carries the person and no tenant, role or address', async () => {
    const token = await issuer.issue(subject, ISSUED_AT);

    const [, payload] = token.split('.');
    const claims: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );

    expect(Object.keys(claims as object).sort()).toEqual([
      'exp',
      'iat',
      'iss',
      'sub',
    ]);
    expect((claims as { sub: string }).sub).toBe(subject);
  });
});

describe('token configuration', () => {
  it('reports the signing secret when it is missing', () => {
    expect(() => loadTokenConfig({})).toThrow(/AUTH_TOKEN_SECRET/);
  });

  it('rejects a signing secret too short to be worth having', () => {
    expect(() => loadTokenConfig({ AUTH_TOKEN_SECRET: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('accepts a sufficient secret and applies the default lifetime', () => {
    const config = loadTokenConfig({ AUTH_TOKEN_SECRET: SECRET });

    expect(config.secret).toBe(SECRET);
    expect(config.accessTokenLifetimeSeconds).toBe(900);
  });
});
