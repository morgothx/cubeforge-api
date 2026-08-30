/**
 * Hosts this project is allowed to talk to.
 *
 * Steering states it as a rule rather than a preference: everything here targets
 * Floci, and a real deployment would be a deliberate, human-approved step.
 * Enforcing it in code rather than trusting a `.env` means a copied production
 * value fails at startup instead of writing one tenant's history somewhere it
 * cannot be taken back from — or, now, sending one tenant's questions there.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'floci']);

/**
 * Refuses an endpoint that is not the local emulator.
 *
 * Shared by every adapter that speaks to one, rather than written once per
 * feature: two copies of a refusal are two chances for one of them to be
 * relaxed, and this is the check standing between a throwaway credential and a
 * real account.
 */
export function requireLocalEmulator(endpoint: string, setting: string): void {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error(`${setting} is not a URL: "${endpoint}"`);
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `${setting} must point at the local emulator, got "${host}". ` +
        'This project never talks to a real account; a real deployment is a ' +
        'deliberate, human-approved step outside this path.',
    );
  }
}
