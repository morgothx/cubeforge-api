import { createRequire } from 'node:module';

import { JwtService } from '@nestjs/jwt';
import {
  JwtAccessTokenIssuer,
  type TokenConfig,
} from '../crypto/access-token-issuer';
import { personId, tenantId } from '../../domain/identifiers';
import {
  CONTEXT_LIFETIME_SECONDS,
  SignedSecurityContext,
  TENANT_CLAIM,
} from './security-context';
import type { SemanticConfig } from './semantic-config';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const NOW = new Date('2026-03-05T10:00:00.000Z');

const MODEL_SECRET = 'a-secret-for-the-model-at-least-32-chars';
const PLATFORM_SECRET = 'a-different-secret-for-the-platform-32ch';

const CONFIG: SemanticConfig = {
  url: 'http://cube:4000',
  secret: MODEL_SECRET,
  questionTimeoutMs: 30_000,
};

const PLATFORM: TokenConfig = {
  secret: PLATFORM_SECRET,
  accessTokenLifetimeSeconds: 900,
};

const issuer = () => new SignedSecurityContext(CONFIG);

function claimsOf(context: string): Record<string, unknown> {
  return new JwtService().verify<Record<string, unknown>>(context, {
    secret: MODEL_SECRET,
    algorithms: ['HS256'],
    ignoreExpiration: true,
  });
}

describe('the context one question is asked with', () => {
  it('names the tenant the platform resolved, under the name the model reads', async () => {
    const claims = claimsOf(await issuer().for(ACME, NOW));

    expect(claims[TENANT_CLAIM]).toBe(ACME);
  });

  /**
   * Nothing about the caller travels.
   *
   * The model is told which tenant to confine an answer to and nothing else. A
   * person, a role or a token in here would be something the model could be
   * asked to believe, and what a caller says about themselves is precisely what
   * must not become that.
   */
  it('carries the tenant and the times, and nothing else at all', async () => {
    const claims = claimsOf(await issuer().for(ACME, NOW));

    expect(Object.keys(claims).sort()).toEqual(
      [TENANT_CLAIM, 'exp', 'iat'].sort(),
    );
  });

  it('expires within the life of one question', async () => {
    const claims = claimsOf(await issuer().for(ACME, NOW));

    const issued = Math.floor(NOW.getTime() / 1000);
    expect(claims.iat).toBe(issued);
    expect(claims.exp).toBe(issued + CONTEXT_LIFETIME_SECONDS);
    expect(CONTEXT_LIFETIME_SECONDS).toBeLessThanOrEqual(60);
  });

  it('mints a fresh one per question rather than keeping one', async () => {
    const later = new Date(NOW.getTime() + 5_000);

    const first = await issuer().for(ACME, NOW);
    const second = await issuer().for(ACME, later);

    expect(second).not.toBe(first);
    expect(claimsOf(second).iat).toBe(Math.floor(later.getTime() / 1000));
  });

  /**
   * The two credentials are not interchangeable, and that is enforced by the
   * secrets differing rather than by anyone remembering.
   *
   * Sharing one would mean a platform access token could be presented directly
   * to the semantic layer — and the failure would be silent, because both would
   * verify.
   */
  it('is refused by the platform, and a platform token is refused by the model', async () => {
    const context = await issuer().for(ACME, NOW);
    const platform = new JwtAccessTokenIssuer(PLATFORM);

    expect(await platform.verify(context, NOW)).toBeNull();

    const token = await platform.issue(
      personId('22222222-2222-4222-8222-222222222222'),
      NOW,
    );
    expect(() => claimsOf(token)).toThrow();
  });

  it('refuses a tenant identifier that is not one, before signing anything', async () => {
    await expect(
      issuer().for('not-a-uuid' as typeof ACME, NOW),
    ).rejects.toThrow('tenant identifier');
  });

  /**
   * The two copies of the claim name, driven against each other.
   *
   * `cube/configuration.js` names it too and cannot import this constant — one
   * is JavaScript the container loads, the other TypeScript the API compiles.
   * A probe that renamed it here broke nothing, because every test read the
   * same copy: the drift is invisible from either side alone. Reading the other
   * file is what makes it visible without starting a container.
   */
  it('agrees with the name the model reads it under', () => {
    const configuration = createRequire(__filename)(
      '../../../cube/configuration.js',
    ) as { TENANT_CLAIM: string };

    expect(TENANT_CLAIM).toBe(configuration.TENANT_CLAIM);
  });
});
