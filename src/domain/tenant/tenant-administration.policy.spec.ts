import { DomainViolation } from '../errors';
import { assertTenantRetainsAdministrator } from './tenant-administration.policy';

describe('assertTenantRetainsAdministrator', () => {
  it('rejects a change that removes the only administrator', () => {
    expect(() =>
      assertTenantRetainsAdministrator({
        activeAdministratorCount: 1,
        changeRemovesAnAdministrator: true,
      }),
    ).toThrow(DomainViolation);
  });

  it('reports the last-administrator violation specifically', () => {
    try {
      assertTenantRetainsAdministrator({
        activeAdministratorCount: 1,
        changeRemovesAnAdministrator: true,
      });
      fail('expected the change to be rejected');
    } catch (caught) {
      expect(caught).toBeInstanceOf(DomainViolation);
      expect((caught as DomainViolation).error).toEqual({
        kind: 'last-administrator',
      });
    }
  });

  it('permits the change when another administrator remains', () => {
    expect(() =>
      assertTenantRetainsAdministrator({
        activeAdministratorCount: 2,
        changeRemovesAnAdministrator: true,
      }),
    ).not.toThrow();
  });

  it('permits a change that does not remove an administrator', () => {
    expect(() =>
      assertTenantRetainsAdministrator({
        activeAdministratorCount: 1,
        changeRemovesAnAdministrator: false,
      }),
    ).not.toThrow();
  });
});
