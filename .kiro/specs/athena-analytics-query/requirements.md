# Requirements — athena-analytics-query

## Project Description (Input)

### Who has the problem

- **The dashboard, which has nothing to draw.** Roadmap steps 8 and 9 — the Cube
  semantic layer and the full dashboard — both read analytical data. Neither can
  begin against history that exists only as objects nobody queries.
- **The transactional database, still.** Steering states it plainly: heavy
  analysis must never touch the OLTP store. The previous feature moved the
  history out; nothing yet reads it from where it went, so the only place a
  metric could be computed today is still `stock_movements`.
- **The reviewer.** The platform can now show an export that partitions a
  tenant's history for a query engine. It cannot yet show the query engine —
  which is the half of "AWS + multi-tenancy + embedded BI" that turns a bucket
  of files into an answer.

### Current situation

`s3-data-export` is complete. Every active tenant's movements and catalogue land
in one bucket as Parquet, under keys chosen for exactly this feature:

```
movements/tenant_id=<uuid>/recorded_date=<YYYY-MM-DD>/<from>-<to>.parquet
products/tenant_id=<uuid>/products.parquet
locations/tenant_id=<uuid>/locations.parquet
```

The dataset comes before the tenant so a query engine can point one table at one
prefix and read partition values out of the path below it. The column names and
types are a published contract living in `src/domain/export/exported-row.ts`,
put there so that renaming one breaks a build rather than a chart months later.
Nothing has ever queried any of it.

Athena and Glue are not reached by any code in this repository. Both respond in
Floci, and the pipeline was proven end to end before this spec was written:
a Glue table over `movements/`, one `SELECT count(*)`, two rows back — the same
two the export had just written.

**Two fidelity gaps were found in that same experiment, and they shape this
feature more than anything else in this description.**

1. **Floci needs no partitions registered.** It derived `tenant_id` from the key
   path and filtered on it correctly with nothing in the catalogue. Real Athena
   returns no rows for a partitioned table until partitions are registered or
   partition projection is configured. So the partition decision **cannot be
   validated locally at all** — the local engine passes whether the decision is
   right or wrong.
2. **The engine underneath is DuckDB, not Presto.** A failing `SHOW PARTITIONS`
   named it: `floci-duck ... COPY (…) TO 's3://…'`. Athena's dialect, its DDL
   and its functions are not what runs here.

This is the lesson the previous feature paid for four times — a double looser
than the thing it stands for hides the bug it exists to catch — arriving at the
scale of an entire engine. Everything this feature claims about Athena
specifically, rather than about SQL over the exported objects, is a claim a
local test cannot settle, and the spec has to say which claims those are rather
than discover it in the last task.

### What should change

A query adapter over the exported objects, behind a port, with the tenant
supplied by the seam and never by the caller, answering a small fixed set of
inventory questions. One tenant-scoped HTTP route exists so that the isolation
can be proven through a real request rather than only at the adapter. Cube
consumes the port in step 8; it does not consume the route.

## Decisions taken before drafting

Four questions this description left open, and the answers this document is
written against.

1. **A query port and an Athena adapter, plus one route that proves the
   isolation.** Tenant isolation over analytical storage is the property this
   project exists to demonstrate, and an adapter tested in isolation cannot show
   it surviving a real request. A full analytical HTTP surface was rejected:
   Cube replaces it in step 8, so most of it would be work built to be deleted.
2. **Partition projection, not a registered catalogue.** The exported keys are
   perfectly regular — a UUID and a date, both enumerable — which is exactly the
   shape projection wants, and it removes the entire class of failures where a
   day is written but invisible because nothing registered it. Registering
   partitions after each run was rejected for adding a step that can fail
   silently between a correct export and a correct query. **This is declared and
   documented, not verified:** Floci needs no partitions, so no local test can
   distinguish a correct projection from a missing one.
3. **The adapter injects the tenant predicate at the seam.** The same shape as
   `runInTenant`: the caller cannot supply a tenant, so "forgot to filter" is
   not expressible rather than merely refused. A workgroup or IAM prefix per
   tenant is closer to how real AWS would do it and was rejected for this
   feature precisely because Floci does not emulate it — it would be an
   isolation claim with no probe behind it, which is the thing this project
   does not ship.
4. **A small fixed set of inventory questions**, named in the domain the way the
   exported columns are, so step 8 defines metrics over something stable. A
   general query interface was rejected: every freely composed query is another
   surface the tenant filter can be lost on, and the isolation story is the one
   this feature cannot afford to weaken.

Three more, answered while drafting these requirements:

5. **Every answer says how far the data reaches.** An analytical answer is only
   as complete as the last export, and a chart that shows yesterday's stock with
   today's confidence is worse than one that admits its date. It also decides
   something for step 8: a semantic layer choosing between the transactional
   store and this one needs to know where this one ends.
6. **An answer carries the code and the current name.** The catalogue is
   exported for exactly this — requirement 1.4 of the previous feature asks for
   "the attributes a reader needs to name it in a chart" — and resolving names
   against the transactional store instead would put labelling load on the
   database this whole pipeline exists to keep out of the way.
7. **The three tenant roles may all ask.** The same rule the inventory read
   routes apply: reading aggregates of one's own tenant discloses nothing a
   viewer cannot already see. Machine callers are excluded for now, because the
   cost of an analytical question would then be decided by an automated client.

## Requirements

### 1. What can be asked

**User story:** As a dashboard user, I want a named set of inventory questions
answered from the exported data, so that drawing a chart never costs the
transactional database anything.

#### Acceptance criteria

1.1 The Analytics Query shall answer, for the tenant the caller is acting in,
how much of each product is on hand.

1.2 The Analytics Query shall answer, for the tenant the caller is acting in,
how much moved on each day of a period the caller names.

1.3 The Analytics Query shall present each product and each location by its code
and by its current name.

1.4 If the caller names no period, the Analytics Query shall refuse the question
rather than reading the whole of a tenant's history.

1.5 If the caller names a period longer than the platform permits, the Analytics
Query shall refuse the question and state the longest period it will answer.

1.6 The Analytics Query shall not offer a way to compose a question of the
caller's own devising.

### 2. Whose records an answer contains

**User story:** As a tenant, I want an analytical answer to contain only my
records, so that leaving the transactional database is not where isolation stops
holding.

#### Acceptance criteria

2.1 The Analytics Query shall include in an answer only records belonging to the
tenant the caller is acting in.

2.2 The Analytics Query shall not accept a tenant named in the question itself.

2.3 When two tenants ask the same question, the Analytics Query shall answer
each of them from that tenant's records only.

2.4 The Analytics Query shall not read the exported data of a tenant other than
the one the caller is acting in.

2.5 If a question cannot be answered, the Analytics Query shall name no tenant
other than the one the caller is acting in, and no record of any tenant.

### 3. How far an answer reaches

**User story:** As a dashboard user, I want to know how current an answer is, so
that I can tell a number that is settled from one that is merely the latest I
have been given.

#### Acceptance criteria

3.1 The Analytics Query shall report, with every answer, the moment through
which the answer is complete.

3.2 The Analytics Query shall not include activity recorded after the moment it
reports.

3.3 If a tenant's data has never been carried out of the transactional database,
the Analytics Query shall say so rather than answering as though nothing had
happened.

3.4 The Analytics Query shall not read the transactional database to answer a
question.

3.5 When data for a day has been carried out of the transactional database, the
Analytics Query shall answer questions covering that day without an operator
preparing anything by hand.

### 4. What an answer looks like

**User story:** As a chart, I want answers I can draw without repairing them, so
that every consumer does not re-implement the same parsing and sorting.

#### Acceptance criteria

4.1 The Analytics Query shall present each value with its type intact, so that a
quantity reads as a number and a moment as a moment rather than as text.

4.2 If a period contains no activity, the Analytics Query shall answer with no
entries rather than refusing the question.

4.3 The Analytics Query shall order the entries of an answer the same way for
the same question.

4.4 The Analytics Query shall not include, in any answer, a record that
identifies a person.

### 5. Asking over the API

**User story:** As a dashboard user, I want to ask these questions the same way I
ask every other question of this platform, so that nothing about analytics is a
second way in.

#### Acceptance criteria

5.1 The Analytics Query shall require an authenticated caller, and shall take the
tenant from the same place every other tenant-scoped request takes it.

5.2 The Analytics Query shall admit administrators, editors and viewers alike.

5.3 If the caller holds no active membership in the tenant, the Analytics Query
shall answer indistinguishably from how it answers for a tenant that does not
exist.

5.4 The Analytics Query shall validate a question's parameters before reading
anything.

5.5 The Analytics Query shall limit how often one caller may ask.

### 6. When a question cannot be answered

**User story:** As a dashboard user, I want a failure to arrive quickly and say
what kind it was, so that a slow answer and a broken one are not the same
experience.

#### Acceptance criteria

6.1 If the analytical store cannot be reached, the Analytics Query shall report
that the answer is unavailable and shall not answer from the transactional
database instead.

6.2 If a question has not been answered within the time the platform allows, the
Analytics Query shall stop waiting and report that it did.

6.3 If a question fails, the Analytics Query shall report a class of problem and
shall not disclose the question it ran, the location of any data, or any
credential.

6.4 The Analytics Query shall record every failure against the correlation
identifier of the request that caused it.

### 7. Configuration and its refusals

**User story:** As an operator, I want a misconfigured analytical path to refuse
to start, so that a missing setting is a message rather than an empty chart.

#### Acceptance criteria

7.1 If the analytical store or its catalogue is not configured, the Analytics
Query shall refuse to answer and name what is missing.

7.2 The Analytics Query shall read its configuration from the environment rather
than from values written into the repository.

7.3 The Analytics Query shall target the local emulator and shall require no
real cloud account to run or to be tested.

## Scope boundaries

**This feature owns:** the named set of questions and what their answers
contain, confining every answer to one tenant, reporting how far the data
reaches, the one route through which a person asks, and the refusals when the
analytical store is missing, unreachable or too slow.

**This feature relies on, and does not own:**

- **The exported data itself** — its layout, its columns, its partitioning and
  how far each tenant has been carried belong to `s3-data-export`. This feature
  reads what that one writes and changes nothing about it.
- **Who the caller is** — authentication and the resolution of a principal
  belong to `authentication`; the role check belongs to
  `rbac-authorization-guards`. This feature declares which roles may ask.
- **Metric definitions** — naming a business measure once and serving it to a
  frontend belongs to `cube-semantic-layer`. This feature answers questions; it
  does not define what a metric means.
- **The dashboard** — how an answer is drawn belongs to `dashboard-frontend`.

**Explicitly out of scope:** a general-purpose query interface, any question
about a dataset the export does not write, scheduling, caching or
pre-aggregation of answers, and any claim about a real cloud account.

**Known limit of local verification.** The behaviour required by 3.5 — that an
exported day is answerable with nothing prepared by hand — is stated because it
is what a caller needs, and it cannot be distinguished locally from its own
absence: the emulator answers whether or not the arrangement behind it is
correct. The design must say plainly which of its claims a local test settles
and which it does not.
