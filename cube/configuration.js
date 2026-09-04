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

/** Whether an address is one of the emulator's, without refusing anything. */
function isLocalEmulator(endpoint) {
  try {
    return LOCAL_HOSTS.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/**
 * A number written the way a number is written, and nothing looser.
 *
 * No leading zeros, no exponent, no padding, no thousands separator. A product
 * code of `0012` is text and stays text; `12` would be retyped, which is the
 * one case this cannot tell apart and the reason the repair is confined to the
 * emulator. Against a real engine none of this runs.
 */
const WRITTEN_AS_A_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Retypes the columns the emulator flattened, using the values it returned.
 *
 * The emulator reports **every** column as `varchar`, including one the query
 * cast to `BIGINT` — read off its `ColumnInfo`, where `Precision` and `Scale`
 * are `0` for all of them. So there is no metadata to convert, and no SQL that
 * repairs it: the flattening is in what the engine says about the answer rather
 * than in the answer.
 *
 * The design assumed the driver's type mapping could be overridden to fix this.
 * It cannot — the mapping's only input carries no signal — so the types are
 * repaired from the rows instead. Without some repair **nothing prepared can be
 * read at all**: every read of a prepared answer ends in a sum, including a
 * count, and Cube Store refuses to sum text.
 *
 * A column is retyped only when it has at least one value and every non-null
 * value is written as a plain number. One value that is not turns the whole
 * column back to text, because a column that is numeric in this batch and
 * textual in the next is worse than one that is text in both.
 */
function repairTypes(types, rows) {
  return types.map((column) =>
    column.type === 'text' && everyValueIsANumber(column.name, rows)
      ? { ...column, type: 'bigint' }
      : column,
  );
}

function everyValueIsANumber(name, rows) {
  const present = rows
    .map((row) => row[name])
    .filter((value) => value !== null && value !== undefined);

  return (
    present.length > 0 &&
    present.every(
      (value) =>
        typeof value === 'number' ||
        (typeof value === 'string' && WRITTEN_AS_A_NUMBER.test(value)),
    )
  );
}

/**
 * The driver class to build, repairing types only against the emulator.
 *
 * Installed for the emulator's address and for no other. This repair exists
 * because of the emulator and must never teach the model to distrust a real
 * engine's types — the same note the export carries about its own local
 * repairs. Against anything else the stock driver is returned unchanged, so
 * there is no code path where a real engine's answer is second-guessed.
 */
function driverFor(endpoint, AthenaDriver) {
  if (!isLocalEmulator(endpoint)) {
    return AthenaDriver;
  }

  return class EmulatorTypeRepairingDriver extends AthenaDriver {
    downloadQueryResults(query, values, options) {
      const pending = super.downloadQueryResults(query, values, options);

      // The promise the driver returns is cancellable, and Cube cancels it.
      // Wrapping it plainly would drop that, leaving a query running on the
      // engine after the thing that wanted it had gone away.
      const repaired = Promise.resolve(pending).then((result) =>
        Array.isArray(result.rows) && Array.isArray(result.types)
          ? { ...result, types: repairTypes(result.types, result.rows) }
          : result,
      );
      repaired.cancel = () => pending.cancel();

      return repaired;
    }
  };
}

module.exports = {
  LOCAL_HOSTS,
  requireLocalEmulator,
  isLocalEmulator,
  engineAddress,
  driverOptions,
  repairTypes,
  driverFor,
};
