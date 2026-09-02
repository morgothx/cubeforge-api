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

## Decisions taken before drafting

Five questions the description left open, and the answers this document is
written against.

1. **Cube reads the exported objects directly; it does not consume
   `TenantScopedAnalytics`.** Cube is a separate process, so consuming the port
   would mean publishing it and writing a driver against it — and the driver has
   no good shape. Limited to the port's two questions it cannot be a semantic
   layer at all; accepting composed queries it turns the port into the general
   query interface the previous feature declared it could not afford. Reading
   the same exported data through its own connection keeps the port closed and
   lets the model be a model. **This reverses the assumption stated in
   `athena-analytics-query/requirements.md:67`**, which said Cube would consume
   the port; that spec's `design.md:592` correctly left it open.
2. **Every question arrives through the platform's API.** The alternative —
   the API signs a credential and the browser asks the semantic layer directly —
   was rejected for two reasons: it makes the semantic layer a publicly reachable
   surface, and it moves rate limiting out of the one place that currently owns
   it. The cost accepted is one more hop per question.
3. **The exported objects are the only source.** A second connection to the
   transactional store would give fresher numbers and would contradict the rule
   this pipeline exists to honour: heavy analysis never touches the OLTP store.
   The price is that an answer is only as current as the last export, which is
   why requirement 4 makes that visible rather than silent.
4. **At least one question is prepared in advance.** `tech.md` justifies the
   semantic layer running as a long-lived service — the one documented exception
   to statelessness — on the grounds that it needs a persistent cache. A feature
   that defined no prepared question would leave that justification uncollected,
   and an unverified justification is the kind this project does not ship.
5. **The two existing analytical routes keep their port.** They answer something
   the model does not: a union in which "this tenant has never been exported" is
   an answer rather than an error. Rewriting them onto the model would trade a
   guarantee for a symmetry nobody asked for.

## Requirements

### 1. What a measure is, and where it is named

**User story:** As a dashboard user, I want to choose measures and groupings
without a developer defining a new question for each chart, so that the second
chart costs what the first one taught rather than the same work again.

#### Acceptance criteria

1.1 The Semantic Layer shall define each business measure once, and serve that
one definition to every caller that asks for it.

1.2 The Semantic Layer shall offer measures over the exported movements,
including the net quantity moved and the number of movements recorded.

1.3 The Semantic Layer shall offer the on-hand quantity of a product as a
measure, defined as the sum of the movements affecting it.

1.4 The Semantic Layer shall offer groupings by the day a movement was recorded,
the day it occurred, its kind, the product it names, and the location it names.

1.5 The Semantic Layer shall label each product and each location by its code and
by its current name, taken from the exported catalogue.

1.6 The Semantic Layer shall allow one question to combine measures, groupings
and a period of the caller's choosing, without a definition written for that
combination.

1.7 If a caller names a measure or a grouping the model does not define, the
Semantic Layer shall refuse the question and name the definitions it offers.

### 2. What one question may cost

**User story:** As an operator, I want a composed question to carry its own
bounds, so that the freedom to ask anything does not become the freedom to read
a tenant's whole history at once.

#### Acceptance criteria

2.1 If a caller names no period, the Semantic Layer shall refuse the question
rather than read the whole of a tenant's history.

2.2 If a caller names a period longer than the platform permits, the Semantic
Layer shall refuse the question and state the longest period it will answer.

2.3 The Semantic Layer shall bound how many rows one answer may contain.

2.4 If a question would produce more rows than the bound allows, the Semantic
Layer shall say so rather than return part of an answer as if it were all of it.

### 3. Whose records an answer contains

**User story:** As a tenant, I want a modelled answer to contain only my records,
so that adding a second way to ask does not add a second way to leak.

#### Acceptance criteria

3.1 The Semantic Layer shall include in an answer only records belonging to the
tenant the caller is acting in.

3.2 The Semantic Layer shall not accept a tenant named in the question itself.

3.3 The Semantic Layer shall take the tenant from the standing the platform has
already established for the caller, and from nowhere else.

3.4 When two tenants ask the same question, the Semantic Layer shall answer each
of them from that tenant's records only.

3.5 If a modelled question would read the exported objects without naming a
tenant, the Semantic Layer shall return no records rather than records of every
tenant.

3.6 If a question cannot be answered, the Semantic Layer shall name no tenant
other than the one the caller is acting in, and no record of any tenant.

### 4. How a question reaches the model

**User story:** As an operator, I want every analytical question to arrive
through the same door as every other request, so that authorization and rate
limiting are decided in one place rather than two.

#### Acceptance criteria

4.1 The Semantic Layer shall accept a question only from the platform's API.

4.2 The Semantic Layer shall not answer a caller that the platform has not
authorized, including a caller that reaches it without passing through the API.

4.3 The Semantic Layer shall not accept a caller's own description of who they
are or where they may act.

4.4 The Semantic Layer shall answer a question from any of the three tenant
roles, and shall not answer one from a machine caller.

4.5 The Semantic Layer shall limit how often one caller may ask, and shall tell a
refused caller how long to wait.

4.6 If a caller asks about a tenant they hold no active membership in, the
Semantic Layer shall answer as it would for a tenant that does not exist.

### 5. How current an answer is

**User story:** As a dashboard user, I want to know how current a modelled number
is, so that I can tell a settled figure from the latest one available.

#### Acceptance criteria

5.1 The Semantic Layer shall state, with every answer, the moment through which
the data behind it is complete.

5.2 The Semantic Layer shall read only the exported objects, and shall not read
the transactional store.

5.3 If the tenant has never been exported, the Semantic Layer shall say so, and
shall say something different from what it says for a period containing no
records.

5.4 When a period contains no records, the Semantic Layer shall answer with no
rows rather than refuse.

5.5 The Semantic Layer shall not report an answer as complete through a moment
later than the export it was computed from.

### 6. Answers prepared before they are asked for

**User story:** As a dashboard user, I want the questions the dashboard asks
constantly to come back quickly, so that moving a date range is not a wait.

#### Acceptance criteria

6.1 The Semantic Layer shall prepare in advance at least one question, chosen for
being asked often.

6.2 When a caller asks a prepared question, the Semantic Layer shall answer it
from what was prepared rather than by reading the exported objects again.

6.3 The Semantic Layer shall make it observable, for a given answer, whether it
came from what was prepared or from the exported objects.

6.4 The Semantic Layer shall rebuild what it prepared after new data has been
exported, without a person asking it to.

6.5 The Semantic Layer shall confine prepared data to one tenant in the same way
it confines an answer read directly.

6.6 When a caller asks a question that was not prepared, the Semantic Layer
shall answer it by reading the exported objects.

### 7. When a question cannot be answered

**User story:** As a dashboard user, I want a failure to say which kind of
failure it is, so that a chart can tell "nothing here" from "something broke".

#### Acceptance criteria

7.1 If the exported objects cannot be reached, the Semantic Layer shall refuse
the question rather than answer with part of it.

7.2 If a question has not been answered within the time the platform allows, the
Semantic Layer shall stop it and refuse, rather than let a caller wait
indefinitely.

7.3 If the model is not available, the Semantic Layer shall refuse analytical
questions only, and every other route of the platform shall go on answering.

7.4 The Semantic Layer shall include in a refusal no storage location, no
statement it ran, and no identifier belonging to another tenant.

### 8. Configuration and its refusals

**User story:** As an operator, I want the platform to start and serve
everything else when the semantic layer is not configured, so that one absent
service does not take the API down with it.

#### Acceptance criteria

8.1 The Semantic Layer shall not prevent the platform from starting when it is
not configured.

8.2 If the semantic layer is not configured and a caller asks a modelled
question, the platform shall refuse that question and state that the capability
is unavailable.

8.3 If the semantic layer is configured with settings it cannot use, the
Semantic Layer shall refuse the question and name what is missing, rather than
answer from an incomplete configuration.

8.4 The Semantic Layer shall require no credential belonging to a real cloud
account in order to run locally or in continuous integration.

## Scope boundaries

**This feature owns:** the model in which every measure and grouping is defined
once, confining a modelled answer to one tenant, the single door through which a
question arrives, what a prepared answer is and when it is rebuilt, how current
an answer says it is, and the refusals when the model or the exported objects
cannot serve.

**This feature relies on, and does not own:**

- **The exported data** — its columns, its partitioning and how far each tenant
  has been carried belong to `s3-data-export`. This feature reads what that one
  writes and changes nothing about it.
- **The query engine over it** — the catalogue and the engine's own refusal of an
  unconstrained read belong to `athena-analytics-query`. This feature models over
  that catalogue; it does not redefine it.
- **Who the caller is** — authentication and the resolution of a principal belong
  to `authentication`, and the role check to `rbac-authorization-guards`. This
  feature declares which roles may ask.
- **The two existing analytical routes** — they keep answering through their own
  port, including the state this feature's answers do not carry.
- **How an answer is drawn** — charts, controls and the choosing of measures in a
  browser belong to `dashboard-frontend` (step 9).

**Explicitly out of scope:** a second data source over the transactional store,
any deployment of the semantic layer beyond the local compose stack, modelling a
dataset the export does not write, arbitrary customer schemas, and any claim
about a real cloud account.

**Known limits of local verification.** Two claims here cannot be settled by a
local test, and the design must say so plainly rather than let a passing suite
imply otherwise:

- **3.5** rests on the engine refusing a read that names no tenant. The emulator
  needs no partitions and derives the tenant from the object's path, so it
  answers whether or not the arrangement behind the requirement is correct — the
  same limit `athena-analytics-query` recorded for its own requirement 3.5.
- **6.2** is only as trustworthy as 6.3 makes it. An instrument that cannot
  distinguish a prepared answer from a freshly read one turns 6.2 into a claim
  about the instrument, which is why 6.3 is a requirement and not a note.
