import type { IssuedApiKey } from '../../../application/api-key/issue-api-key.use-case';
import type { IssuedSession } from '../../../application/authentication/sign-in.use-case';
import type {
  CallerStanding,
  StandingMembership,
} from '../../../application/identity/describe-caller.use-case';
import type { CreateTenantMemberResult } from '../../../application/membership/create-tenant-member.use-case';
import type { ApiKeySummary } from '../../../application/ports/api-key.repository';
import type { ListedMember } from '../../../application/membership/list-tenant-members.use-case';
import type { ProvisionedTenant } from '../../../application/tenant/provision-tenant.use-case';
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

/**
 * What provisioning answers, which is a tenant plus the one fact the operator
 * needs next: who they just made its administrator. Listing tenants does not
 * carry it — an operator browsing the platform has no such errand.
 */
export interface ProvisionedTenantResponse extends TenantResponse {
  readonly administratorPersonId: string;
}

export function toProvisionedTenantResponse(
  provisioned: ProvisionedTenant,
): ProvisionedTenantResponse {
  return {
    ...toTenantResponse(provisioned.tenant),
    administratorPersonId: provisioned.administratorPersonId,
  };
}

export interface MemberResponse {
  readonly membershipId: string;
  readonly personId: string;
  /** Absent entirely for a caller who is not an administrator here (2.1.1). */
  readonly email?: string;
  readonly role: string;
  readonly active: boolean;
}

/**
 * The field is omitted rather than sent as `null`, so a listing without
 * addresses says "not for you" instead of implying these people have none.
 */
export function toMemberResponse(entry: ListedMember): MemberResponse {
  return {
    membershipId: entry.membershipId,
    personId: entry.personId,
    ...(entry.email === null ? {} : { email: entry.email }),
    role: entry.role,
    active: entry.active,
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

export interface CallerMembershipResponse {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly role: string;
}

export interface CallerResponse {
  readonly personId: string;
  readonly email: string;
  readonly isOperator: boolean;
  readonly memberships: readonly CallerMembershipResponse[];
}

/**
 * The caller's own standing, and the only response in the API that carries an
 * email address to somebody who is not an administrator of the tenant the
 * address belongs to. It is theirs — requirement 1.5 — and they typed it to
 * sign in.
 *
 * Named field by field, like every other mapping here, so that a field added
 * to `CallerStanding` cannot become a published field by accident.
 */
export function toCallerResponse(standing: CallerStanding): CallerResponse {
  return {
    personId: standing.personId,
    email: standing.email,
    isOperator: standing.isOperator,
    memberships: standing.memberships.map(toCallerMembershipResponse),
  };
}

function toCallerMembershipResponse(
  membership: StandingMembership,
): CallerMembershipResponse {
  return {
    tenantId: membership.tenantId,
    tenantName: membership.tenantName,
    role: membership.role,
  };
}
