import { opaqueSecret } from '../../domain/credential/secrets';
import { RandomSecretGenerator } from './random-secret-generator';

describe('generating and digesting opaque secrets', () => {
  const generator = new RandomSecretGenerator();

  it('produces a secret with at least 128 bits of entropy', () => {
    const secret = generator.generate();

    // base64url of 32 bytes: 256 bits, comfortably past the 128 required.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const secrets = new Set(
      Array.from({ length: 1000 }, () => generator.generate()),
    );

    expect(secrets.size).toBe(1000);
  });

  it('digests deterministically, so a presented secret can be found', () => {
    const secret = generator.generate();

    expect(generator.digest(secret)).toBe(generator.digest(secret));
  });

  it('produces different digests for different secrets', () => {
    expect(generator.digest(generator.generate())).not.toBe(
      generator.digest(generator.generate()),
    );
  });

  /**
   * The digest is what gets stored, so it must not be reversible to the value
   * the caller was handed — and must not contain it.
   */
  it('does not carry the secret inside its digest', () => {
    const secret = opaqueSecret('a-known-value-for-this-assertion');

    const digest = generator.digest(secret);

    expect(digest).not.toContain(secret);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
