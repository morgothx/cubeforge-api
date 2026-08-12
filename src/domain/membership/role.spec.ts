import { PERMITTED_ROLES, parseRole } from './role';

describe('parseRole', () => {
  it.each(['admin', 'editor', 'viewer'])('accepts %s', (value) => {
    const result = parseRole(value);

    expect(result.ok).toBe(true);
    expect(result.ok && result.role).toBe(value);
  });

  it('reports the permitted roles when given an unknown value', () => {
    const result = parseRole('superuser');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.permitted).toEqual([
      'admin',
      'editor',
      'viewer',
    ]);
  });

  it('does not accept a role differing only in case or padding', () => {
    expect(parseRole('Admin').ok).toBe(false);
    expect(parseRole(' admin ').ok).toBe(false);
  });

  it('exposes the permitted roles as the single source of truth', () => {
    expect(PERMITTED_ROLES).toEqual(['admin', 'editor', 'viewer']);
  });
});
