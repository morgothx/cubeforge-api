import { tenantId } from '../identifiers';
import {
  createTenant,
  deactivateTenant,
  isTenantActive,
} from './tenant.entity';

const id = tenantId('018f2c00-0000-7000-8000-000000000001');
const createdAt = new Date('2026-08-12T00:00:00.000Z');

describe('tenant', () => {
  it('is active when created and records its creation time', () => {
    const tenant = createTenant({ id, name: 'Acme', createdAt });

    expect(tenant.status).toBe('active');
    expect(tenant.createdAt).toEqual(createdAt);
    expect(isTenantActive(tenant)).toBe(true);
  });

  it('becomes inactive on deactivation while retaining its data', () => {
    const tenant = deactivateTenant(
      createTenant({ id, name: 'Acme', createdAt }),
    );

    expect(tenant.status).toBe('inactive');
    expect(isTenantActive(tenant)).toBe(false);
    expect(tenant.id).toBe(id);
    expect(tenant.name).toBe('Acme');
    expect(tenant.createdAt).toEqual(createdAt);
  });

  it('leaves an already inactive tenant unchanged', () => {
    const once = deactivateTenant(
      createTenant({ id, name: 'Acme', createdAt }),
    );
    const twice = deactivateTenant(once);

    expect(twice).toEqual(once);
  });

  it('rejects a blank name', () => {
    expect(() => createTenant({ id, name: '   ', createdAt })).toThrow();
  });

  it('does not expose any way to remove a tenant', () => {
    const tenant = createTenant({ id, name: 'Acme', createdAt });

    expect(Object.keys(tenant)).toEqual(['id', 'name', 'status', 'createdAt']);
  });
});
