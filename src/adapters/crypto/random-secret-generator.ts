import { createHash, randomBytes } from 'node:crypto';
import {
  opaqueSecret,
  secretDigest,
  type OpaqueSecret,
  type SecretDigest,
} from '../../domain/credential/secrets';

/** 256 bits. The requirement is 128; the cost of doubling it is nine characters. */
const SECRET_BYTES = 32;

/**
 * Setup tokens, refresh tokens and API keys are all the same thing: a value the
 * platform generated, handed over once, and later recognizes.
 *
 * The digest is a plain SHA-256, not a password hash, and that is deliberate.
 * Password hashing is slow to survive guessing at human-chosen values; these
 * are 256 random bits, so there is nothing to guess. Making verification slow
 * would only make every authenticated request slower, which is a real cost paid
 * for no protection.
 */
export class RandomSecretGenerator {
  generate(): OpaqueSecret {
    return opaqueSecret(randomBytes(SECRET_BYTES).toString('base64url'));
  }

  digest(secret: OpaqueSecret): SecretDigest {
    return secretDigest(createHash('sha256').update(secret).digest('hex'));
  }
}
