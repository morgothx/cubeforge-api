import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PERMITTED_ROLES } from '../../../domain/membership/role';

/**
 * An upper bound on anything a caller can make the server hash or digest.
 * Argon2 is deliberately slow, so an unbounded password field is a way to buy
 * server time by the megabyte.
 */
const SECRET_MAX_LENGTH = 1024;

/**
 * The edge validates shape; the domain re-validates the invariants it owns.
 *
 * The permitted roles come from the domain rather than being restated here, so
 * requirement 4.5 cannot end up reporting one set at the edge and another
 * further in. Adding a role is a single edit in one file.
 */
export class CreateTenantRequest {
  @IsString()
  @MinLength(1, { message: 'name must not be blank' })
  @MaxLength(200)
  name!: string;

  /**
   * Provisioning names the first administrator, because a tenant nobody can
   * administer cannot be used: adding a member requires an administrator to
   * already exist.
   */
  @IsEmail({}, { message: 'administratorEmail must be a valid address' })
  administratorEmail!: string;
}

export class CreateTenantMemberRequest {
  @IsEmail({}, { message: 'email must be a valid address' })
  email!: string;

  @IsIn(PERMITTED_ROLES, {
    message: `role must be one of: ${PERMITTED_ROLES.join(', ')}`,
  })
  role!: string;
}

export class ChangeMemberRoleRequest {
  @IsIn(PERMITTED_ROLES, {
    message: `role must be one of: ${PERMITTED_ROLES.join(', ')}`,
  })
  role!: string;
}

/**
 * Deliberately not `@IsEmail`, and deliberately no minimum password length.
 *
 * Every way signing in can fail produces one response, and the use case goes as
 * far as verifying a decoy so that even the timing agrees. A 400 for a
 * malformed address or a too-short password would undo that at the edge: it
 * tells the caller their guess was never going to match, which is precisely
 * what the identical rejections are there to withhold. Shape is still bounded,
 * because the cost of hashing is real.
 */
export class SignInRequest {
  @IsString()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(SECRET_MAX_LENGTH)
  password!: string;
}

export class RefreshSessionRequest {
  @IsString()
  @Matches(/\S/, { message: 'refreshToken must not be blank' })
  @MaxLength(SECRET_MAX_LENGTH)
  refreshToken!: string;
}

export class SignOutRequest {
  @IsString()
  @Matches(/\S/, { message: 'refreshToken must not be blank' })
  @MaxLength(SECRET_MAX_LENGTH)
  refreshToken!: string;

  /** Absent means this session only, which is the safer reading of silence. */
  @IsOptional()
  @IsBoolean()
  everywhere?: boolean;
}

/**
 * The password policy is not restated here. The domain owns it and reports it
 * as a validation failure with the rule attached, so the caller learns the same
 * thing either way — and there is only one place to change when it changes.
 */
export class RedeemSetupTokenRequest {
  @IsString()
  @Matches(/\S/, { message: 'token must not be blank' })
  @MaxLength(SECRET_MAX_LENGTH)
  token!: string;

  @IsString()
  @MaxLength(SECRET_MAX_LENGTH)
  password!: string;
}

export class IssueApiKeyRequest {
  @IsString()
  @MinLength(1, { message: 'label must not be blank' })
  @MaxLength(200)
  label!: string;

  @IsIn(PERMITTED_ROLES, {
    message: `role must be one of: ${PERMITTED_ROLES.join(', ')}`,
  })
  role!: string;
}
