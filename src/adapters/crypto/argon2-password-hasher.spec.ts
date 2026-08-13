import { passwordDigest } from '../../domain/credential/secrets';
import {
  Argon2PasswordHasher,
  loadHashingConfig,
} from './argon2-password-hasher';

describe('hashing and verifying passwords', () => {
  // Deliberately below the production baseline so the suite stays quick; the
  // parameters are configuration precisely so this is possible.
  const hasher = new Argon2PasswordHasher({
    memoryCostKiB: 8192,
    timeCost: 1,
    parallelism: 1,
  });
  const password = 'correct horse battery staple';

  it('accepts the password it hashed', async () => {
    const digest = await hasher.hash(password);

    await expect(hasher.verify(password, digest)).resolves.toBe(true);
  });

  it('rejects a different password', async () => {
    const digest = await hasher.hash(password);

    await expect(
      hasher.verify('something else entirely', digest),
    ).resolves.toBe(false);
  });

  it('produces a different digest each time, so equal passwords are not equal digests', async () => {
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);

    expect(first).not.toBe(second);
    await expect(hasher.verify(password, first)).resolves.toBe(true);
    await expect(hasher.verify(password, second)).resolves.toBe(true);
  });

  it('never returns the password inside the digest', async () => {
    const digest = await hasher.hash(password);

    expect(digest).not.toContain(password);
    expect(digest).toMatch(/^\$argon2id\$/);
  });

  /**
   * A stored digest that is not a digest at all — a truncated column, a value
   * written by something else — must be a failed verification, not a crash that
   * reveals the difference between "wrong password" and "broken record".
   */
  it('treats an unreadable digest as a failed verification', async () => {
    await expect(
      hasher.verify(password, passwordDigest('not-a-real-digest')),
    ).resolves.toBe(false);
  });
});

describe('hashing configuration', () => {
  it('applies the baseline when nothing is configured', () => {
    const config = loadHashingConfig({});

    expect(config.memoryCostKiB).toBeGreaterThanOrEqual(19456);
    expect(config.timeCost).toBeGreaterThanOrEqual(2);
    expect(config.parallelism).toBeGreaterThanOrEqual(1);
  });

  it('rejects a configured cost that is not a positive integer', () => {
    expect(() => loadHashingConfig({ AUTH_ARGON2_TIME_COST: 'soon' })).toThrow(
      /AUTH_ARGON2_TIME_COST/,
    );
    expect(() => loadHashingConfig({ AUTH_ARGON2_MEMORY_KIB: '0' })).toThrow(
      /AUTH_ARGON2_MEMORY_KIB/,
    );
  });

  it('accepts configured costs', () => {
    const config = loadHashingConfig({
      AUTH_ARGON2_MEMORY_KIB: '65536',
      AUTH_ARGON2_TIME_COST: '3',
      AUTH_ARGON2_PARALLELISM: '2',
    });

    expect(config).toEqual({
      memoryCostKiB: 65536,
      timeCost: 3,
      parallelism: 2,
    });
  });
});
