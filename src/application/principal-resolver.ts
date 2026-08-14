import { Inject, Injectable } from '@nestjs/common';
import type { OpaqueSecret } from '../domain/credential/secrets';
import type { TenantId } from '../domain/identifiers';
import type { ActorContext } from './actor-context';
import {
  ACCESS_TOKEN_ISSUER,
  type AccessTokenIssuer,
} from './ports/access-token-issuer';
import {
  AUTHENTICATOR_UNIT_OF_WORK,
  type AuthenticatorUnitOfWork,
} from './ports/authenticator-unit-of-work';
import { CLOCK, type Clock } from './ports/clock';
import {
  SECRET_GENERATOR,
  type SecretGenerator,
} from './ports/secret-generator';

export type PresentedCredential =
  | {
      readonly scheme: 'access-token';
      readonly token: string;
      /** Taken from the request path, never from the token. */
      readonly tenantId: TenantId | null;
    }
  | { readonly scheme: 'api-key'; readonly secret: OpaqueSecret };

/**
 * Turns a presented secret into an actor, or into nothing.
 *
 * `null` rather than an exception, because an anonymous request is ordinary and
 * requirement 10.3 wants it answered as an absent record — which is what the
 * use cases already do when no actor reaches them.
 */
@Injectable()
export class PrincipalResolver {
  constructor(
    @Inject(ACCESS_TOKEN_ISSUER) private readonly tokens: AccessTokenIssuer,
    @Inject(AUTHENTICATOR_UNIT_OF_WORK)
    private readonly authenticator: AuthenticatorUnitOfWork,
    @Inject(SECRET_GENERATOR) private readonly secrets: SecretGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolve(credential: PresentedCredential): Promise<ActorContext | null> {
    const now = this.clock.now();

    if (credential.scheme === 'api-key') {
      return this.resolveApiKey(credential.secret, now);
    }
    return this.resolveAccessToken(credential.token, credential.tenantId, now);
  }

  private async resolveApiKey(
    secret: OpaqueSecret,
    now: Date,
  ): Promise<ActorContext | null> {
    return this.authenticator.runAuthenticating(async ({ apiKeys }) => {
      const key = await apiKeys.resolve(this.secrets.digest(secret));
      if (key === null) {
        return null;
      }

      // Recorded on the way through, so "last used" means what it says without
      // any route remembering to say it.
      await apiKeys.recordUse(key.id, now);
      return {
        kind: 'machine' as const,
        apiKeyId: key.id,
        tenantId: key.tenantId,
        role: key.role,
      };
    });
  }

  /**
   * The tenant comes from the path and the person from the token, and the two
   * are combined here without either being verified against the other —
   * authorization resolves the membership from stored records on every request,
   * and duplicating that check here would create two places to keep in
   * agreement.
   *
   * A request that names a tenant is treated as a tenant member even when the
   * person is also an operator, so someone who administers the platform and
   * belongs to a customer can still act in both. Operator status is only how a
   * request that names no tenant is interpreted.
   */
  private async resolveAccessToken(
    token: string,
    tenantId: TenantId | null,
    now: Date,
  ): Promise<ActorContext | null> {
    const personId = await this.tokens.verify(token, now);
    if (personId === null) {
      return null;
    }

    if (tenantId !== null) {
      return { kind: 'tenant-member', personId, tenantId };
    }

    // Read from storage on every request, so withdrawing operator status takes
    // effect at once rather than when a token happens to expire (11.4).
    const isOperator = await this.authenticator.runAuthenticating(
      ({ operators }) => operators.isOperator(personId),
    );
    return isOperator ? { kind: 'platform-operator', personId } : null;
  }
}
