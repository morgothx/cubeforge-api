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

/**
 * The one claim a security context carries.
 *
 * Named here and minted under the same name by `security-context.ts` on the
 * TypeScript side. The two cannot share a constant across the process boundary,
 * so the integration suite asking a real question through a real context is
 * what holds them together — a rename on one side and not the other stops
 * every question rather than quietly widening one.
 */
const TENANT_CLAIM = 'tenantId';

/**
 * Confines every modelled question to one tenant, and refuses one it cannot.
 *
 * The tenant is taken from the signed context the platform mints, never from
 * the question — `ModelledQuestion` has nowhere to put one, and this is the
 * other half of that: there is nothing in the query for a caller to have set.
 *
 * **A context carrying no tenant is refused, not answered.** Returning the
 * query untouched would read every tenant's rows, which is the one failure this
 * project exists to make impossible. The engine's own `injected` projection
 * stands underneath this refusal and is not verifiable from here, so this one
 * is not allowed to be the soft half of a pair.
 *
 * The value is checked for being a non-empty string and no further. It becomes
 * a filter *value*, which Cube carries as a parameter rather than as text, and
 * its shape was already refused twice before it was signed. A third copy of
 * that rule would be a third thing to keep in step without a third gate.
 */
function queryRewrite(query, context) {
  const securityContext = context && context.securityContext;
  const tenant =
    securityContext && typeof securityContext === 'object'
      ? securityContext[TENANT_CLAIM]
      : undefined;

  if (typeof tenant !== 'string' || tenant.length === 0) {
    throw new Error(
      'a modelled question must arrive with a tenant in its security context',
    );
  }

  query.filters = [
    ...(query.filters || []),
    ...cubesNamedIn(query).map((cube) => ({
      member: `${cube}.tenant_id`,
      operator: 'equals',
      values: [tenant],
    })),
  ];

  return query;
}

/**
 * Every cube the question touches, each confined separately.
 *
 * Filtering only the first would leave a joined cube unfiltered, and a join is
 * exactly where a second tenant's rows would arrive. All four exported datasets
 * are partitioned by tenant, so every cube in the model carries the dimension.
 */
function cubesNamedIn(query) {
  const members = [
    ...(query.measures || []),
    ...(query.dimensions || []),
    ...(query.segments || []),
    ...(query.timeDimensions || []).map((each) => each.dimension),
  ];

  return [...new Set(members.map((member) => String(member).split('.')[0]))];
}

/**
 * The SQL dialect to compile with, repaired only against the emulator.
 *
 * Cube compiles an Athena question through the Presto dialect, which writes a
 * timestamp as `from_iso8601_timestamp(...)`. The emulator's engine is DuckDB
 * and has no such function — measured: `CAST('2020-01-01T00:00:00.000Z' AS
 * TIMESTAMP)` succeeds against it and `from_iso8601_timestamp(...)` fails. So
 * **no question carrying a period compiles at all** locally, which is every
 * question this feature answers.
 *
 * The cast is the portable spelling of the same thing: real Athena accepts it
 * too. It is still installed for the emulator only, for the reason the type
 * repair gives — a repair that exists because of the emulator must never be
 * the thing a real engine depends on.
 */
function dialectFor(endpoint, AthenaQuery) {
  if (!isLocalEmulator(endpoint)) {
    return AthenaQuery;
  }

  return class EmulatorTimestampDialect extends AthenaQuery {
    timeStampParam() {
      return 'CAST(? AS TIMESTAMP)';
    }

    timeStampCast(value) {
      return `CAST(${value} AS TIMESTAMP)`;
    }

    dateTimeCast(value) {
      return `CAST(${value} AS TIMESTAMP)`;
    }

    /**
     * No timezone arithmetic, because there is no timezone to convert.
     *
     * Presto shifts a column with `date_add('minute', ...)`, which DuckDB does
     * not have in that form. It does not need it here: every moment this
     * platform stores, exports and asks about is UTC — `Day` is UTC, a period's
     * ends are UTC, and the export partitions by a UTC date. Converting UTC to
     * UTC is the identity.
     *
     * A question in any other timezone is **refused rather than answered
     * wrongly**. Silently returning the field would give an answer shifted by
     * the hours nobody applied, which is the kind of wrong that looks right.
     */
    convertTz(field) {
      if (this.timezone && this.timezone !== 'UTC') {
        throw new Error(
          `the local engine answers in UTC only, and this question asked for ${this.timezone}`,
        );
      }

      return field;
    }

    /**
     * The time series a rolling window needs, spelled for this engine.
     *
     * Presto builds one with `SEQUENCE(...)`; DuckDB has no such function and
     * builds the same series with `unnest(generate_series(...))` — measured
     * against the running engine, both the absence and the replacement.
     *
     * Without this, `on_hand_quantity` cannot be answered at all: a rolling
     * window is evaluated against a series of dates, and requirement 1.3 is
     * what asks for the rolling window in the first place.
     */
    sqlTemplates() {
      const templates = super.sqlTemplates();

      templates.statements.time_series_select =
        'SELECT CAST(dates.f AS TIMESTAMP) date_from, CAST(dates.t AS TIMESTAMP) date_to \n' +
        'FROM (\n' +
        '{% for time_item in seria  %}' +
        "    select '{{ time_item[0] }}' f, '{{ time_item[1] }}' t \n" +
        '{% if not loop.last %} UNION ALL\n{% endif %}' +
        '{% endfor %}' +
        ') AS dates';

      templates.statements.generated_time_series_select =
        'SELECT d AS date_from,\n' +
        'd + INTERVAL {{ granularity }} - INTERVAL 1 millisecond AS date_to\n' +
        'FROM (SELECT unnest(generate_series(\n' +
        'CAST({{ start }} AS TIMESTAMP), CAST({{ end }} AS TIMESTAMP), INTERVAL {{ granularity }}\n' +
        ')) AS d) AS dates';

      templates.statements.generated_time_series_with_cte_range_source =
        'SELECT d AS date_from,\n' +
        'd + INTERVAL {{ granularity }} - INTERVAL 1 millisecond AS date_to\n' +
        'FROM {{ range_source }} CROSS JOIN (SELECT unnest(generate_series(\n' +
        'CAST({{ range_source }}.{{ min_name }} AS TIMESTAMP),\n' +
        'CAST({{ range_source }}.{{ max_name }} AS TIMESTAMP),\n' +
        'INTERVAL {{ granularity }}\n' +
        ')) AS d) AS dates';

      return templates;
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
  TENANT_CLAIM,
  queryRewrite,
  dialectFor,
};
