import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { PERMITTED_ROLES } from '../../../domain/membership/role';

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
