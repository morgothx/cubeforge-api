# Requirements — s3-data-export

## Project Description (Input)

### Who has the problem

- **The analytical half of the platform, which does not exist yet.** Roadmap
  steps 7 through 9 — Athena, the Cube semantic layer, the dashboard — all read
  columnar data in object storage. None of them can begin against a database
  that holds its history only in PostgreSQL. This is the feature that puts the
  data where they can read it.
- **The transactional database.** Steering states the point plainly: heavy
  analysis must never touch the OLTP store. Today the only place a metric could
  be computed is `stock_movements` itself, which is also the table an upstream
  system writes to on a schedule. Without an export, the first real chart makes
  the write path slower.
- **The reviewer.** The platform can show authentication, authorization,
  tenant isolation and an idempotent write path. It cannot yet show data
  leaving the database on a schedule, partitioned, in a format an analytical
  engine reads — which is the half of "AWS + multi-tenancy + embedded BI" that
  the transactional features do not demonstrate.

### Current situation

Five features are complete. `stock_movements` is append-only and carries two
timestamps on purpose: `occurred_at`, which the source system reports and may
backdate, and `recorded_at`, which only ever moves forward. That second column
was added with this feature in mind and has never been read by anything.

`inventory_products` and `inventory_locations` hold tenant-owned reference data
that is declared idempotently and updated in place.

Nothing on the platform writes to object storage, reads AWS credentials, or
runs on a schedule. Floci is running locally and emulates S3; no code has
called it. The three inventory tables live behind `ENABLE` plus `FORCE`
row-level security under the `cubeforge_app` identity, which holds `SELECT` and
`INSERT` on movements and no `DELETE` anywhere.

### What should change

A tenant-partitioned export of inventory history from PostgreSQL to Parquet in
S3, runnable as an operator command and callable by a scheduler later. Movements
are exported incrementally by `recorded_at` so a written partition is never
rewritten; the catalogue is exported as a full snapshot each run, because it is
small and mutable. What the export writes is what step 7 will point Athena at.

## Decisions taken before drafting

Four questions the description left open, and the answers this document is
written against.

1. **Movements plus the catalogue, and nothing else.** `stock_movements`,
   `inventory_products` and `inventory_locations` — exactly what a stock metric
   needs to be named as well as counted. Tenants and memberships stay out: no
   metric asks for them, and exporting them would put personal data in an
   analytical bucket to no one's benefit.
2. **An operator command in front of a schedulable port.** `pnpm ops:export`
   runs a real export against Floci today; the scheduler that calls it belongs
   to the deployment feature, where there is a runtime that is not Camilo's
   machine. A cron inside the API process was rejected because it cannot be
   exercised end to end and ties the export to a single instance.
3. **Hybrid: movements incremental, catalogue full.** Movements are append-only
   and carry `recorded_at`, so an incremental export never rewrites a partition —
   the whole reason the column exists. The catalogue is updated in place and is
   small; a snapshot per run is simpler than tracking versions of a renamed
   product, and leaves nothing for a reader to resolve.
4. **One bucket, partitioned by tenant and by the day of `recorded_at`.**
   Isolation is expressed in the prefix rather than left to every query to
   filter, and Athena prunes by partition. Partitioning by `occurred_at` was
   rejected for the reason requirement 3.4 of the previous feature already
   states: a backdated movement would force a closed partition to be rewritten.

Three more, answered while drafting these requirements:

5. **A tenant that fails does not stop the others.** The run continues and
   reports per tenant, the same shape as a movement batch reporting per row. A
   whole-run abort was rejected for the same reason: one tenant with odd data
   must not cost every other tenant its nightly export.
6. **Every movement appears in the exported data exactly once**, including
   after a run that failed halfway. Steering already requires that replaying a
   mutating operation produces no duplicate effects; pushing deduplication into
   every future query and into the semantic layer would make that somebody
   else's permanent problem.
7. **The catalogue snapshot replaces the previous one.** A reader sees the
   catalogue as it is now. Keeping dated versions is history no requirement
   asks for, and would force every query to choose a version.

## Requirements

### 1. What leaves the transactional database

**User story:** As an operator, I want the export to carry exactly the data the
analytical layer needs, so that no record travels to analytical storage without
a reason to be there.

#### Acceptance criteria

1.1 The Data Export shall export stock movements, products and locations for
every active tenant.

1.2 The Data Export shall not export tenants, memberships, people, credentials,
or any record that identifies a person.

1.3 The Data Export shall export, for each movement, the identifier the source
system supplied, the product, the location, the kind, the quantity, when it
occurred and when it was recorded.

1.4 The Data Export shall export, for each product and location, its code and
the attributes a reader needs to name it in a chart.

1.5 If a tenant is inactive, the Data Export shall leave that tenant's
previously exported data in place and export nothing further for it.

### 2. Movements, exported incrementally

**User story:** As an operator, I want each run to carry only what is new, so
that the cost of an export follows the day's activity rather than the whole
history.

#### Acceptance criteria

2.1 The Data Export shall export only the movements recorded since the point
reached by the previous successful export of that tenant.

2.2 The Data Export shall advance the point reached for a tenant only after the
data covering it has been written completely.

2.3 If a run fails after writing part of a tenant's data, then the next run
shall produce exported data in which every movement appears exactly once.

2.4 If a run fails after writing part of a tenant's data, then the Data Export
shall not skip any movement covered by the failed run.

2.5 The Data Export shall not include a movement that was recorded after the
run began, leaving it for the next run.

2.6 The Data Export shall not skip a movement whose recording time is earlier
than one already exported but which became visible to readers later.

2.7 The Data Export shall export a movement only once that movement is visible
to any reader of the transactional database.

2.8 The Data Export shall not alter or remove data it has already reported as
exported.

### 3. The catalogue, exported whole

**User story:** As an analytical reader, I want the products and locations to
read as they are today, so that a chart names a renamed product once and
correctly.

#### Acceptance criteria

3.1 The Data Export shall export the current products and locations of each
tenant on every run.

3.2 When a product or location has been renamed since the previous run, the
Data Export shall present only the current name to a reader.

3.3 The Data Export shall replace a tenant's previous catalogue rather than
adding to it.

3.4 If a tenant has declared no products or locations, the Data Export shall
present no catalogue entries for that tenant.

3.5 If writing a tenant's catalogue fails, the Data Export shall leave the
previous catalogue readable rather than partially replaced.

### 4. Where the data lands

**User story:** As an analytical engine, I want the exported data laid out by
tenant and by day, so that a query for one tenant and one week reads neither
another tenant's data nor the rest of history.

#### Acceptance criteria

4.1 The Data Export shall write each tenant's data under a location that names
that tenant.

4.2 The Data Export shall partition movements by the day on which they were
recorded.

4.3 If a movement occurred on an earlier day than the one it was recorded on,
the Data Export shall place it in the partition of the day it was recorded.

4.4 When a run adds movements to a day already written, the Data Export shall
add to that partition without rewriting what is already there.

4.5 The Data Export shall write no records of one tenant under another tenant's
location.

4.6 The Data Export shall write files in a columnar format that the analytical
engine reads without conversion.

4.7 The Data Export shall preserve each value's type, so that a quantity reads
as a number and a moment as a moment rather than as text.

### 5. Running an export

**User story:** As an operator, I want to run an export by hand today and hand
the same operation to a scheduler later, so that the schedule is a deployment
decision rather than a rewrite.

#### Acceptance criteria

5.1 The Data Export shall run a full export from a single command, requiring no
interactive input.

5.2 When an operator names a single tenant, the Data Export shall export only
that tenant.

5.3 When a run completes, the Data Export shall report, per tenant, how many
movements it exported, how many partitions it wrote, and the point it reached.

5.4 When a run completes with every tenant exported, the Data Export shall exit
reporting success.

5.5 If any tenant failed, the Data Export shall exit reporting failure.

5.6 While an export is running, the Data Export shall not prevent the
transactional API from accepting and answering requests.

5.7 If an export is run when nothing has been recorded since the previous one,
the Data Export shall export no movements and report the tenant as up to date.

### 6. When a run goes wrong

**User story:** As an operator, I want one tenant's failure to cost only that
tenant, so that a single bad night does not leave the whole platform unexported.

#### Acceptance criteria

6.1 If exporting one tenant fails, the Data Export shall continue with the
remaining tenants.

6.2 If exporting one tenant fails, the Data Export shall report which tenant
failed and why.

6.3 If exporting one tenant fails, the Data Export shall not advance that
tenant's point reached.

6.4 If exporting one tenant fails, the Data Export shall leave every other
tenant's export complete and their points reached advanced.

6.5 If object storage cannot be reached, the Data Export shall stop and advance
no tenant's point reached.

6.6 If a previous run left a tenant's data incompletely written, the Data
Export shall bring that tenant to a complete state without an operator
repairing anything by hand.

### 7. What the exported data may disclose

**User story:** As a tenant, I want my data to stay mine after it leaves the
transactional database, so that analytical storage is not the place isolation
stops holding.

#### Acceptance criteria

7.1 The Data Export shall include, in a tenant's exported data, only records
belonging to that tenant.

7.2 If a tenant's export fails, the Data Export shall not name another tenant's
records in what it reports.

7.3 The Data Export shall not write credentials, tokens or record contents into
its output messages.

7.4 The Data Export shall carry one correlation identifier through everything
it reports for a single run.

### 8. Configuration and its refusals

**User story:** As an operator, I want a misconfigured export to refuse to
start, so that a missing setting is a message rather than a partially written
day.

#### Acceptance criteria

8.1 If the destination or its endpoint is not configured, the Data Export shall
refuse to run and name what is missing.

8.2 If the configured credentials are rejected, the Data Export shall stop
before writing anything and report that they were rejected.

8.3 The Data Export shall target the local emulator and shall require no real
cloud account to run or to be tested.

8.4 The Data Export shall read its configuration from the environment rather
than from values written into the repository.

## Scope boundaries

**This feature owns:** reading each tenant's movements and catalogue, writing
them to object storage partitioned by tenant and by day, remembering how far
each tenant has been exported, recovering from a run that failed part-way, and
the operator command that runs an export and reports what it did.

**This feature relies on, and does not own:**

- **A movement, once recorded, is never amended or removed, and the moment it
  was recorded never moves backwards.** Both are guarantees of
  `inventory-sync-api`. This feature reads them; it does not re-establish them,
  and it is the reason `recorded_at` exists.
- **Tenant isolation inside the transactional database** — row-level security
  and the tenant-scoped seam, delivered by `rbac-authorization-guards` and the
  persistence foundation. This feature inherits it, and must not become the
  first reader that steps around it.
- **The local emulator** as the only cloud this platform talks to, stated in
  steering.

**Explicitly out of scope:**

- **Registering the exported data with a query engine** — table definitions,
  partition discovery and the queries themselves belong to
  `athena-analytics-query` (roadmap step 7).
- **Metric definitions over the exported data** — `cube-semantic-layer`
  (step 8).
- **Running the export on a schedule inside a deployed runtime.** This feature
  provides an operation a scheduler can call; it does not schedule itself, and
  the runtime that would do the scheduling does not exist yet.
- **Compacting small files, retention and lifecycle rules.** They become worth
  building when the volume that motivates them exists.
- **Erasing a tenant's exported data.** Nothing on the platform deletes tenant
  data yet, and an erasure path invented alongside its first writer tends to be
  wrong.
- **Exporting anything but inventory.** Identity and access data stays in the
  transactional database.
