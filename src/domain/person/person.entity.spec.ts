import { emailAddress, personId } from '../identifiers';
import {
  createPerson,
  deactivatePerson,
  isPersonActive,
} from './person.entity';

const id = personId('018f2c00-0000-7000-8000-000000000002');
const email = emailAddress('camilo@example.com');
const createdAt = new Date('2026-08-12T00:00:00.000Z');

describe('person', () => {
  it('is active when created', () => {
    const person = createPerson({ id, email, createdAt });

    expect(person.status).toBe('active');
    expect(isPersonActive(person)).toBe(true);
  });

  it('retains its record once deactivated so past work stays attributable', () => {
    const person = deactivatePerson(createPerson({ id, email, createdAt }));

    expect(person.status).toBe('deactivated');
    expect(isPersonActive(person)).toBe(false);
    expect(person.id).toBe(id);
    expect(person.email).toBe(email);
    expect(person.createdAt).toEqual(createdAt);
  });

  it('leaves an already deactivated person unchanged', () => {
    const once = deactivatePerson(createPerson({ id, email, createdAt }));

    expect(deactivatePerson(once)).toEqual(once);
  });
});
