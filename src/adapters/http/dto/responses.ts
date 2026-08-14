import type { IssuedApiKey } from '../../../application/api-key/issue-api-key.use-case';
import type { IssuedSession } from '../../../application/authentication/sign-in.use-case';
import type { CreateTenantMemberResult } from '../../../application/membership/create-tenant-member.use-case';
import type { ApiKeySummary } from '../../../application/ports/api-key.repository';
import type { MembershipWithPerson } from '../../../application/ports/membership.repository';
import type { OpaqueSecret } from '../../../domain/credential/secrets';
import type { Tenant } from '../../../domain/tenant/tenant.entity';

export interface TenantResponse {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
}

/**
 * Built field by field rather than by spreading the entity. A response that
 * spreads whatever the domain happens to carry will one day leak a field nobody
 * decided to publish; listing them is how the contract stays a decision.
 */
export function toTenantResponse(tenant: Tenant): TenantResponse {
  return {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
  };
}

export interface MemberResponse {
  readonly membershipId: string;
  readonly personId: string;
  readonly email: string;
  readonly role: string;
  readonly active: boolean;
}

export function toMemberResponse(entry: MembershipWithPerson): MemberResponse {
  return {
    membershipId: entry.membership.id,
    personId: entry.membership.personId,
    email: entry.email,
    role: entry.membership.role,
    // Requirement 10.1 asks whether the membership is active, not what its
    // status string happens to be — a person deactivated platform-wide is not
    // active here either.
    active:
      entry.membership.status === 'active' && entry.personStatus === 'active',
  };
}

export interface CreatedMemberResponse {
  readonly membershipId: string;
  readonly personId: string;
  readonly role: string;
}

/**
 * Deliberately identical in both branches of requirement 4.2: there is no field
 * that could differ between a person the platform already knew and one it did
 * not, because no such field is produced.
 */
export function toCreatedMemberResponse(
  result: CreateTenantMemberResult,
): CreatedMemberResponse {
  return {
    membershipId: result.membershipId,
    personId: result.personId,
    role: result.role,
  };
}

export interface SessionResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionExpiresAt: string;
}

/**
 * Both tokens here were generated for this response and exist nowhere in
 * storage — the platform keeps a digest of the refresh token and nothing at all
 * of the access token. No stored secret is ever published, which is why there
 * is no operation anywhere that hands either of them out a second time.
 */
export function toSessionResponse(session: IssuedSession): SessionResponse {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    sessionExpiresAt: session.sessionExpiresAt.toISOString(),
  };
}

export interface SetupTokenResponse {
  readonly setupToken: string;
}

export function toSetupTokenResponse(token: OpaqueSecret): SetupTokenResponse {
  return { setupToken: token };
}

export interface IssuedApiKeyResponse {
  readonly id: string;
  readonly secret: string;
}

/** The only response in the API that carries a key secret. See `ApiKeyResponse`. */
export function toIssuedApiKeyResponse(
  key: IssuedApiKey,
): IssuedApiKeyResponse {
  return { id: key.id, secret: key.secret };
}

export interface ApiKeyResponse {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * Listing describes keys; it never reproduces them. The summary the repository
 * returns has no secret to leak, and this mapping names its fields one by one
 * so that a field added there cannot become a field published here.
 */
export function toApiKeyResponse(key: ApiKeySummary): ApiKeyResponse {
  return {
    id: key.id,
    label: key.label,
    role: key.role,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}
