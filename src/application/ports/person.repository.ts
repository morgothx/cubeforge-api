import type { EmailAddress, PersonId } from '../../domain/identifiers';
import type { Person, PersonStatus } from '../../domain/person/person.entity';

/**
 * People, as seen from inside a tenant. The tenant in context can only reach
 * the people who belong to it, which is why there is no way to look one up by
 * email and receive a record back.
 */
export interface PersonRepository {
  findById(personId: PersonId): Promise<Person | null>;

  /**
   * Resolves an address to an identifier, creating the person if the platform
   * does not know them yet, and returning nothing else about them.
   *
   * This exists as one operation rather than a lookup followed by an insert
   * because requirement 4.3 forbids disclosing whether the address was already
   * known. A caller that could tell the two apart would inevitably leak the
   * difference — through a branch, a message, or timing. Here there is no
   * branch to leak: both paths return an identifier and the caller cannot tell
   * which one it took.
   *
   * `candidateId` is used only if the person is created. When the address is
   * already registered, the returned identifier is the existing one.
   */
  findOrCreateByEmail(input: {
    readonly candidateId: PersonId;
    readonly email: EmailAddress;
    readonly createdAt: Date;
  }): Promise<PersonId>;
}

/**
 * The operator's entire reach over people: flipping a status, by identifier.
 *
 * There is no read method, and deactivating an unknown identifier reports
 * success rather than not-found. That is not laxity — requirement 3.3 forbids
 * revealing whether a person exists on the platform, and a not-found response
 * would answer exactly that question.
 */
export interface PlatformPersonRepository {
  updateStatus(personId: PersonId, status: PersonStatus): Promise<void>;
}
