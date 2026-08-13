import type {
  PasswordDigest,
  SecretDigest,
} from '../../../domain/credential/secrets';
import type {
  EmailAddress,
  PersonId,
  SignInId,
} from '../../../domain/identifiers';
import type { PersonStatus } from '../../../domain/person/person.entity';

interface Person {
  readonly id: PersonId;
  readonly status: PersonStatus;
}

/**
 * The credential rows, kept apart from `InMemoryIdentityStore` for the same
 * reason the tables are kept apart from `people`: nothing tenant-scoped may
 * reach them, and two stores make that visible rather than merely intended.
 */
export class InMemoryCredentialStore {
  readonly passwords = new Map<
    PersonId,
    { digest: PasswordDigest; updatedAt: Date }
  >();
  readonly setupTokens = new Map<
    string,
    {
      id: string;
      personId: PersonId;
      secretDigest: SecretDigest;
      expiresAt: Date;
      redeemedAt: Date | null;
    }
  >();
  readonly refreshTokens = new Map<
    string,
    {
      id: string;
      signInId: SignInId;
      personId: PersonId;
      secretDigest: SecretDigest;
      sessionExpiresAt: Date;
      exchangedAt: Date | null;
      invalidatedAt: Date | null;
    }
  >();
  readonly operators = new Set<PersonId>();

  /**
   * People live in the identity store, but authentication has to reach them:
   * signing in starts from an address and must know whether that person is
   * deactivated. The lookup is supplied rather than duplicated so the two
   * stores cannot disagree about who exists.
   */
  constructor(
    private readonly people: {
      byEmail: (email: EmailAddress) => Person | null;
      byId: (id: PersonId) => Person | null;
    },
  ) {}

  personByEmail(email: EmailAddress): Person | null {
    return this.people.byEmail(email);
  }

  personById(id: PersonId): Person | null {
    return this.people.byId(id);
  }
}
