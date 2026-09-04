/**
 * The decisions `cube.js` makes, in a module Cube does not read.
 *
 * They live here rather than in `cube.js` for a measured reason: Cube validates
 * its configuration object strictly and refuses any key it does not know
 * ("Invalid cube-server-core options: \"driverOptions\" is not allowed"), so a
 * helper exported for a test to reach stops the container from starting. The
 * design assumed the spec could require `cube.js` directly. It cannot, and this
 * is the smallest thing that keeps both the container and the test working.
 *
 * Nothing here is a secret. The credentials, the region, the workgroup and the
 * output location reach the driver from the environment the container was
 * started with, which is where they already are.
 */

/**
 * Hosts this project is allowed to talk to.
 *
 * A second copy of `src/adapters/aws/require-local-emulator.ts`, which cannot
 * be imported here: that file is TypeScript inside a project this one is
 * outside of. Two copies of a refusal are two chances for one of them to be
 * relaxed, so the copy is not left to be noticed — the configuration spec
 * drives both over the same hosts and fails if they ever disagree.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'floci']);

/** The same refusal the adapters apply, stated again because it must be. */
function requireLocalEmulator(endpoint, setting) {
  let host;
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

const ENGINE_SETTING = 'CUBE_ATHENA_ENDPOINT';

/**
 * Where the engine is, refused at once if it is not the emulator.
 *
 * Called while `cube.js` is being loaded, which is startup: a container pointed
 * at a real account fails to start rather than answering one question and then
 * being noticed.
 */
function engineAddress(env = process.env) {
  const endpoint = env[ENGINE_SETTING] || 'http://floci:4566';
  requireLocalEmulator(endpoint, ENGINE_SETTING);
  return endpoint;
}

/**
 * What reaches the driver, and the whole of it.
 *
 * `endpoint` is undocumented. It works because `AthenaDriver` destructures the
 * options it knows and spreads **everything else** into the object it hands to
 * `new Athena(...)` — read off the driver in the running container, not
 * inferred from the documentation, which does not mention it. The feature rests
 * on that behaviour, so the spec asserts the key is passed rather than trusting
 * a reader to remember why it is here.
 *
 * Nothing else is set. The driver reads the region, the credentials, the
 * workgroup, the catalogue and the output location from the environment when
 * the options do not carry them.
 */
function driverOptions(env = process.env) {
  return { endpoint: engineAddress(env) };
}

module.exports = {
  LOCAL_HOSTS,
  requireLocalEmulator,
  engineAddress,
  driverOptions,
};
