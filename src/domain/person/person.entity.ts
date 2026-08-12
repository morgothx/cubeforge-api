import type { EmailAddress, PersonId } from '../identifiers';

export type PersonStatus = 'active' | 'deactivated';

/**
 * A person exists once platform-wide and reaches tenants through memberships,
 * which is what lets the same individual belong to several customers.
 */
export interface Person {
  readonly id: PersonId;
  readonly email: EmailAddress;
  readonly status: PersonStatus;
  readonly createdAt: Date;
}

export function createPerson(input: {
  readonly id: PersonId;
  readonly email: EmailAddress;
  readonly createdAt: Date;
}): Person {
  return {
    id: input.id,
    email: input.email,
    status: 'active',
    createdAt: input.createdAt,
  };
}

export function deactivatePerson(person: Person): Person {
  if (person.status === 'deactivated') {
    return person;
  }
  return { ...person, status: 'deactivated' };
}

export function isPersonActive(person: Person): boolean {
  return person.status === 'active';
}
