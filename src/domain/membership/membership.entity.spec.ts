import { membershipId, personId, tenantId } from '../identifiers';
import {
  changeMembershipRole,
  createMembership,
  isMembershipActive,
  revokeMembership,
} from './membership.entity';

const person = personId('018f2c00-0000-7000-8000-000000000002');
const acme = tenantId('018f2c00-0000-7000-8000-000000000001');
const globex = tenantId('018f2c00-0000-7000-8000-000000000003');
const createdAt = new Date('2026-08-12T00:00:00.000Z');

const membership = (
  id: string,
  tenant = acme,
  role: 'admin' | 'viewer' = 'admin',
) =>
  createMembership({
    id: membershipId(id),
    tenantId: tenant,
    personId: person,
    role,
    createdAt,
  });

describe('membership', () => {
  it('is active when created and carries exactly one role', () => {
    const created = membership('018f2c00-0000-7000-8000-00000000000a');

    expect(created.status).toBe('active');
    expect(created.role).toBe('admin');
    expect(isMembershipActive(created)).toBe(true);
  });

  it('lets one person hold different roles in different tenants', () => {
    const inAcme = membership(
      '018f2c00-0000-7000-8000-00000000000a',
      acme,
      'admin',
    );
    const inGlobex = membership(
      '018f2c00-0000-7000-8000-00000000000b',
      globex,
      'viewer',
    );

    expect(inAcme.personId).toBe(inGlobex.personId);
    expect(inAcme.role).toBe('admin');
    expect(inGlobex.role).toBe('viewer');
  });

  it('becomes inactive on revocation while retaining its data', () => {
    const revoked = revokeMembership(
      membership('018f2c00-0000-7000-8000-00000000000a'),
    );

    expect(revoked.status).toBe('revoked');
    expect(isMembershipActive(revoked)).toBe(false);
    expect(revoked.tenantId).toBe(acme);
    expect(revoked.personId).toBe(person);
  });

  it('changes role without touching identity or tenant', () => {
    const changed = changeMembershipRole(
      membership('018f2c00-0000-7000-8000-00000000000a'),
      'viewer',
    );

    expect(changed.role).toBe('viewer');
    expect(changed.tenantId).toBe(acme);
    expect(changed.personId).toBe(person);
    expect(changed.status).toBe('active');
  });

  it('leaves an already revoked membership unchanged', () => {
    const once = revokeMembership(
      membership('018f2c00-0000-7000-8000-00000000000a'),
    );

    expect(revokeMembership(once)).toEqual(once);
  });
});
