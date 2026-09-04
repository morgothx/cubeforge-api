/**
 * What the container reads when it starts.
 *
 * Cube refuses any key on this object it does not know, so it carries its
 * contract and nothing else. Every decision behind it — where the engine is,
 * that it must be the emulator, and what reaches the driver — lives in
 * `configuration.js`, where `src/adapters/semantic/cube-configuration.spec.ts`
 * can load it under this repository's own runner.
 *
 * That spec is what recovers the type-checking this file loses by being
 * JavaScript outside the TypeScript project.
 */
const { driverOptions, engineAddress, driverFor } = require('./configuration');

// At load, which is startup: an address that is not the emulator throws here
// rather than after a question has already been answered.
const OPTIONS = driverOptions();

module.exports = {
  driverFactory: () => {
    // Required inside the factory, not at the top of the file, so that loading
    // this configuration outside the container — where the driver is not
    // installed — remains possible at all.
    const { AthenaDriver } = require('@cubejs-backend/athena-driver');
    return new (driverFor(engineAddress(), AthenaDriver))(OPTIONS);
  },
};
