import { JwtService } from '@nestjs/jwt';
import {
  requireWellFormedTenant,
  type TenantId,
} from '../../domain/identifiers';
import type { SemanticConfig } from './semantic-config';

/**
 * The one claim a context carries, under the name the model reads it by.
 *
 * The same string as `TENANT_CLAIM` in `cube/configuration.js`, which cannot be
 * imported here: that file is JavaScript the container loads and this is
 * TypeScript the API compiles. What holds the two in step is the integration
 * suite asking a real question through a real context — a rename on one side
 * and not the other stops every question rather than quietly widening one,
 * which is the failure mode worth having.
 */
export const TENANT_CLAIM = 'tenantId';

/**
 * How long a context is good for.
 *
 * Long enough for the question it was minted for and no longer. A context that
 * outlives its question is a credential somebody can replay, and the saving
 * from keeping one would be a signature.
 */
export const CONTEXT_LIFETIME_SECONDS = 60;

const ALGORITHM = 'HS256';

/** Mints the standing one question is asked with. */
export interface SecurityContextIssuer {
  for(tenantId: TenantId, now: Date): Promise<string>;
}

/**
 * A short-lived statement that a question is being asked for one tenant.
 *
 * **The caller's own token is never forwarded and is not in scope in this
 * file.** The tenant comes from the standing the platform already established,
 * so what a caller says about who they are cannot become what the model
 * believes. There is nothing here to pass a caller's claims through.
 *
 * **Signed with the model's secret, which is not the platform's** — the
 * configuration loader refuses a deployment where the two are equal. Sharing
 * one would mean a platform access token could be presented directly to the
 * semantic layer, and the failure would be silent because both would verify.
 */
export class SignedSecurityContext implements SecurityContextIssuer {
  private readonly jwt = new JwtService();

  constructor(private readonly config: SemanticConfig) {}

  async for(tenantId: TenantId, now: Date): Promise<string> {
    // Before anything is signed. Below this the value stops being a value and
    // becomes a claim in a token and a filter in a query.
    requireWellFormedTenant(tenantId, 'one a question may be asked for');

    const issuedAt = Math.floor(now.getTime() / 1000);

    // The timestamps are set explicitly rather than left to the library, so the
    // clock the rest of the application injects stays the only source of time —
    // the same reason the access token issuer sets its own.
    return await this.jwt.signAsync(
      {
        [TENANT_CLAIM]: tenantId,
        iat: issuedAt,
        exp: issuedAt + CONTEXT_LIFETIME_SECONDS,
      },
      { secret: this.config.secret, algorithm: ALGORITHM },
    );
  }
}
