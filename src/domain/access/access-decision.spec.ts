import { membershipId, personId, tenantId } from '../identifiers';
import { emailAddress } from '../identifiers';
import {
  createMembership,
  revokeMembership,
} from '../membership/membership.entity';
import { createPerson, deactivatePerson } from '../person/person.entity';
import { createTenant, deactivateTenant } from '../tenant/tenant.entity';
import { decideAccess } from './access-decision';

const createdAt = new Date('2026-08-12T00:00:00.000Z');
const acme = tenantId('018f2c00-0000-7000-8000-000000000001');
const globex = tenantId('018f2c00-0000-7000-8000-000000000003');

const activeTenant = createTenant({ id: acme, name: 'Acme', createdAt });
const activePerson = createPerson({
  id: personId('018f2c00-0000-7000-8000-000000000002'),
  email: emailAddress('camilo@example.com'),
  createdAt,
});
const adminInAcme = createMembership({
  id: membershipId('018f2c00-0000-7000-8000-00000000000a'),
  tenantId: acme,
  personId: activePerson.id,
  role: 'admin',
  createdAt,
});

describe('decideAccess', () => {
  it('grants the role held in the tenant being acted on', () => {
    const decision = decideAccess({
      tenant: activeTenant,
      person: activePerson,
      membership: adminInAcme,
    });

    expect(decision).toEqual({ granted: true, role: 'admin' });
  });

  it('refuses when the tenant is inactive', () => {
    const decision = decideAccess({
      tenant: deactivateTenant(activeTenant),
      person: activePerson,
      membership: adminInAcme,
    });

    expect(decision).toEqual({
      granted: false,
      refusal: { kind: 'tenant-inactive' },
    });
  });

  it('refuses when the person is deactivated platform-wide', () => {
    const decision = decideAccess({
      tenant: activeTenant,
      person: deactivatePerson(activePerson),
      membership: adminInAcme,
    });

    expect(decision).toEqual({
      granted: false,
      refusal: { kind: 'person-deactivated' },
    });
  });

  it('refuses when no membership exists', () => {
    const decision = decideAccess({
      tenant: activeTenant,
      person: activePerson,
      membership: null,
    });

    expect(decision).toEqual({
      granted: false,
      refusal: { kind: 'no-membership' },
    });
  });

  it('refuses when the membership is revoked', () => {
    const decision = decideAccess({
      tenant: activeTenant,
      person: activePerson,
      membership: revokeMembership(adminInAcme),
    });

    expect(decision).toEqual({
      granted: false,
      refusal: { kind: 'membership-revoked' },
    });
  });

  it('never lets a membership in one tenant grant access in another', () => {
    const decision = decideAccess({
      tenant: createTenant({ id: globex, name: 'Globex', createdAt }),
      person: activePerson,
      membership: adminInAcme,
    });

    expect(decision).toEqual({
      granted: false,
      refusal: { kind: 'no-membership' },
    });
  });
});
