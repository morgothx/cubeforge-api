import type {
  OpaqueSecret,
  SecretDigest,
} from '../../domain/credential/secrets';

export const SECRET_GENERATOR = Symbol('SECRET_GENERATOR');

/**
 * Setup tokens, refresh tokens and API keys are all the same thing: a value the
 * platform generated, handed over once, and later recognizes by its digest.
 * They share this contract and nothing else — their lifecycles and their
 * audiences differ, so they do not share a table.
 */
export interface SecretGenerator {
  generate(): OpaqueSecret;
  digest(secret: OpaqueSecret): SecretDigest;
}
