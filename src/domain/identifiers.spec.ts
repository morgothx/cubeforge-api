import {
  emailAddress,
  membershipId,
  personId,
  tenantId,
  type TenantId,
} from './identifiers';

describe('identifiers', () => {
  it('keeps the underlying value of an identifier', () => {
    expect(tenantId('018f2c00-0000-7000-8000-000000000001')).toBe(
      '018f2c00-0000-7000-8000-000000000001',
    );
  });

  it('rejects a blank identifier', () => {
    expect(() => tenantId('   ')).toThrow();
    expect(() => personId('')).toThrow();
    expect(() => membershipId('')).toThrow();
  });

  it('does not accept one kind of identifier where another is expected', () => {
    const takesTenant = (value: TenantId): string => value;

    // @ts-expect-error a person identifier is not a tenant identifier
    expect(takesTenant(personId('018f2c00-0000-7000-8000-000000000002'))).toBe(
      '018f2c00-0000-7000-8000-000000000002',
    );
  });
});

describe('emailAddress', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(emailAddress('  Camilo@Example.COM ')).toBe('camilo@example.com');
  });

  it('treats addresses differing only in case as equal', () => {
    expect(emailAddress('a@b.com')).toBe(emailAddress('A@B.CoM'));
  });

  it('rejects a value that cannot be an address', () => {
    expect(() => emailAddress('')).toThrow();
    expect(() => emailAddress('no-at-sign')).toThrow();
    expect(() => emailAddress('a@')).toThrow();
    expect(() => emailAddress('@b.com')).toThrow();
  });
});
