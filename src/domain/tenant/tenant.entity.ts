import type { TenantId } from '../identifiers';

export type TenantStatus = 'active' | 'inactive';

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly status: TenantStatus;
  readonly createdAt: Date;
}

export function createTenant(input: {
  readonly id: TenantId;
  readonly name: string;
  readonly createdAt: Date;
}): Tenant {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error('tenant name must not be blank');
  }

  return { id: input.id, name, status: 'active', createdAt: input.createdAt };
}

/**
 * Deactivation is a status transition, never a removal: later features attribute
 * transactional and analytical data to tenants that must remain resolvable.
 * Repeating it is a no-op so a retried request cannot fail.
 */
export function deactivateTenant(tenant: Tenant): Tenant {
  if (tenant.status === 'inactive') {
    return tenant;
  }
  return { ...tenant, status: 'inactive' };
}

export function isTenantActive(tenant: Tenant): boolean {
  return tenant.status === 'active';
}
