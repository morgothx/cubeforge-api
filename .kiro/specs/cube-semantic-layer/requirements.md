# Requirements — cube-semantic-layer

## Project Description (Input)

### Who has the problem

- **The dashboard, which cannot be built out of two questions.** Roadmap step 9
  is a full dashboard: measures a person picks, dimensions they group by, a
  period they move. What exists is `stockOnHand()` and `movementsByDay(period)`,
  a deliberately closed pair. Every chart beyond those two is either a new port
  method or it does not exist, and a semantic layer is precisely the thing that
  turns "add a method per chart" into "declare the model once".
- **The Cube container, which has never done anything.** It is in
  `docker-compose.yml` and it starts, on `CUBEJS_DB_TYPE: postgres` pointed at
  the transactional store, with `./cube/model` empty. That configuration
  predates the export pipeline and contradicts the rule steering states plainly:
  heavy analysis must never touch the OLTP store. Today it is scaffolding that
  would break that rule the moment it were used.
- **The reviewer.** The platform can show authentication, authorization, tenant
  isolation, an idempotent write path, a scheduled Parquet export and a query
  engine over it. It cannot yet show the semantic layer — the "embedded BI"
  third of "AWS + multi-tenancy + embedded BI", and the piece that explains why
  the previous two features partitioned the data the way they did.

### Current situation

`athena-analytics-query` is complete and passed its feature gate on 2026-08-31.
Seven backend features are in, twenty-five routes are served, and the analytical
path works end to end: a Glue catalogue over the exported Parquet, an Athena
adapter behind `TenantScopedAnalytics`, and one tenant-scoped HTTP route that
proves the isolation through a real request.

Four facts about that state bear directly on this feature:

- **The port is closed on purpose.** `TenantScopedAnalytics` exposes two
  questions and no way to compose a third, and no method takes a tenant — the
  tenant is bound by `askAs()`. Its own documentation states why: *"A general
  query interface would be another surface for the tenant to be lost on, and
  this is the one property the feature cannot afford to weaken."*
- **Every statement lives in one file.** `AthenaAnalytics` is the only file on
  the platform holding SQL, so the whole dialect surface is reviewable at once
  and there is exactly one place a tenant filter could go missing.
- **The isolation has a second layer that is not our code.** The Glue tables
  declare `projection.tenant_id.type: injected`, which makes a query that does
  not constrain `tenant_id` a refusal from the engine rather than a leak. That
  refusal is **declared and not verified locally**: Floci does not implement
  partition projection, it derives the tenant from the key path.
- **Cube is a process, not a library.** It is a separate container. It cannot be
  handed a Nest provider, so consuming the port from Cube would mean exposing
  the port over HTTP and writing a driver against it.

Nothing in this repository configures Cube, models anything, or issues a Cube
credential. `cube/model` is an empty directory.

### What should change

Cube reads the exported data through its own Athena connection, modelling the
same Glue tables the query adapter reads, so that the semantic layer is a
semantic layer rather than a proxy over two fixed answers.

The tenant is not the model's to choose. The API mints Cube's security context
from the tenant it has already authorized — the same resolution that authorizes
`/tenants/:tenantId/analytics/movements` — and Cube's `queryRewrite` turns that
context into a filter no modelled query can omit. A caller therefore cannot ask
Cube a question about a tenant the API did not grant them, and the `injected`
projection stands underneath as the engine-level refusal if a model is ever
written without the filter.

`TenantScopedAnalytics` survives unchanged. The two existing routes keep using
it, and they answer something Cube does not: the three-state union in which
`never-exported` is an answer rather than an error.

The dashboard's consumption of any of this is roadmap step 9 and out of scope
here.

## Requirements

_Not yet generated. Run `/kiro-spec-requirements cube-semantic-layer`._
