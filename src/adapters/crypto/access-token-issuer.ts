import { JwtService } from '@nestjs/jwt';
import { personId, type PersonId } from '../../domain/identifiers';

/**
 * The token is a signed statement that a person authenticated, and nothing
 * else. It names no tenant and no role (requirements 3.1 and 3.5): a person may
 * hold memberships in several tenants, and a claim about one of them would
 * outlive a membership that can be revoked at any moment. Authorization reads
 * those from stored records on every request instead.
 */
export interface TokenConfig {
  readonly secret: string;
  readonly accessTokenLifetimeSeconds: number;
}

const DEFAULT_LIFETIME_SECONDS = 900;
const MINIMUM_SECRET_LENGTH = 32;
const ISSUER = 'cubeforge';
const ALGORITHM = 'HS256';

type Env = Record<string, string | undefined>;

/**
 * Validated at startup rather than at first sign-in, for the same reason the
 * database settings are: a deployment missing its signing secret should fail
 * immediately, not once someone tries to log in.
 */
export function loadTokenConfig(env: Env): TokenConfig {
  const secret = env.AUTH_TOKEN_SECRET?.trim() ?? '';
  if (secret.length === 0) {
    throw new Error('missing configuration: AUTH_TOKEN_SECRET');
  }
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `AUTH_TOKEN_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`,
    );
  }

  const rawLifetime = env.AUTH_ACCESS_TOKEN_SECONDS?.trim();
  if (rawLifetime === undefined || rawLifetime.length === 0) {
    return { secret, accessTokenLifetimeSeconds: DEFAULT_LIFETIME_SECONDS };
  }

  const lifetime = Number(rawLifetime);
  if (!Number.isInteger(lifetime) || lifetime <= 0) {
    throw new Error(
      `AUTH_ACCESS_TOKEN_SECONDS must be a positive integer, got "${rawLifetime}"`,
    );
  }
  return { secret, accessTokenLifetimeSeconds: lifetime };
}

interface AccessTokenClaims {
  readonly sub: string;
  readonly iss: string;
  readonly iat: number;
  readonly exp: number;
}

export class JwtAccessTokenIssuer {
  private readonly jwt = new JwtService();

  constructor(private readonly config: TokenConfig) {}

  issue(subject: PersonId, issuedAt: Date): Promise<string> {
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);

    // The timestamps are set explicitly rather than left to the library, so the
    // clock the rest of the application injects is the only source of time.
    return this.jwt.signAsync(
      {
        sub: subject,
        iss: ISSUER,
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + this.config.accessTokenLifetimeSeconds,
      },
      { secret: this.config.secret, algorithm: ALGORITHM },
    );
  }

  /**
   * Returns `null` for every unusable token — absent, malformed, expired,
   * signed by someone else. Requirement 3.4 asks for one outcome, and a single
   * return type is how the caller is prevented from accidentally reporting
   * which one it was.
   *
   * The permitted algorithm is pinned here. Accepting whatever the token's own
   * header declares is the classic JWT failure, and it is the verifier's job to
   * refuse that conversation.
   */
  async verify(token: string, now: Date): Promise<PersonId | null> {
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.secret,
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        ignoreExpiration: true,
      });
    } catch {
      return null;
    }

    // Expiry is checked against the supplied instant rather than the library's
    // own reading of the system clock, so a test can place itself in time and
    // the application keeps one notion of "now".
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (claims.exp <= nowSeconds) {
      return null;
    }

    return claims.sub.length === 0 ? null : personId(claims.sub);
  }
}
