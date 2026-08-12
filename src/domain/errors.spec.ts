import { PERMITTED_ROLES } from './membership/role';
import {
  DomainViolation,
  describeDomainError,
  type DomainError,
} from './errors';

describe('domain errors', () => {
  it('carries the structured error when thrown', () => {
    const violation = new DomainViolation({ kind: 'last-administrator' });

    expect(violation).toBeInstanceOf(Error);
    expect(violation.error).toEqual({ kind: 'last-administrator' });
  });

  it('describes every kind without falling through', () => {
    const all: DomainError[] = [
      { kind: 'validation', field: 'name', detail: 'must not be blank' },
      { kind: 'tenant-name-taken' },
      { kind: 'already-a-member' },
      { kind: 'invalid-role', permitted: PERMITTED_ROLES },
      { kind: 'last-administrator' },
      { kind: 'not-found' },
      { kind: 'forbidden' },
    ];

    for (const error of all) {
      expect(describeDomainError(error)).toEqual(expect.any(String));
    }
  });

  it('keeps refusal distinct from absence internally', () => {
    expect(describeDomainError({ kind: 'forbidden' })).not.toEqual(
      describeDomainError({ kind: 'not-found' }),
    );
  });
});
