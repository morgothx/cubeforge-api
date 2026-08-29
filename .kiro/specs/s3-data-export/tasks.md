# Implementation Plan — s3-data-export

Ordered so that nothing waits on something that does not exist yet. The
foundation group establishes what a cursor compares and where it is kept; the
domain group decides what "how far" and "where" mean; the adapters follow; the
seam is widened only once there is something to construct inside it, which is
the mistake this plan's predecessor found the hard way.

`(P)` marks a task that can run alongside its siblings.

## 1. Foundation

- [x] 1.1 Give a movement a transaction identifier a cursor can compare
  - Add the identifier to the movement table, written only by its default, so
    every row carries the transaction that recorded it
  - Existing rows take the migration's own transaction, which is above every
    identifier already committed, so a first export carries the history once
  - Leave the table's policies, grants and append-only guarantees untouched
  - Record in `inventory-sync-api`'s notes that its revalidation trigger fired:
    this feature reads those tables directly and adds a column to one
  - Done when a newly recorded movement carries a higher identifier than one
    recorded before it, and the whole inventory suite is still green
  - _Requirements: 2.6_
  - _Boundary: Persistence schema_

- [x] 1.2 Give each tenant a place to record how far it has been carried
  - A tenant-owned table holding, per dataset, the point exported through and
    the window a run is part-way through
  - Row-level security enabled and forced, with the same predicate every other
    tenant-owned table uses
  - Read, insert and update; no delete, because forgetting how far a tenant was
    carried is not an operation this feature wants to have
  - Done when the application identity is refused a delete by the database, and
    the platform's policy-coverage test passes with the new table present
  - _Requirements: 2.2, 6.3_
  - _Boundary: Persistence schema_

- [x] 1.3 (P) Read the destination from the environment, and refuse without it
  - Bucket, endpoint, region and credentials, read from the environment and
    never from a value written into the repository
  - A missing setting is refused by name rather than discovered as a failure
    half-way through a run
  - Done when a configuration with no bucket is refused naming the bucket, and
    the example environment file documents every setting the export reads
  - _Requirements: 8.1, 8.3, 8.4_
  - _Boundary: Storage configuration_

- [x] 1.4 (P) Take on the two dependencies, and prove the awkward one imports
  - The object-storage client and the columnar writer, added as reviewed
    dependencies
  - The writer is published only as an ES module and this codebase is CommonJS;
    the import has to be shown working from the compiled output, not assumed
  - Done when a throwaway file written by the library is read back by its
    companion reader inside a test that runs under the repository's own build
  - _Requirements: 4.6_
  - _Boundary: Dependencies_

## 2. What "how far" and "where" mean

Pure, no infrastructure. These are the rules that decide whether a movement is
skipped or duplicated, and they are worth being able to test without a database.

- [x] 2.1 (P) Name a window, a cursor, and the moves between them
  - A half-open window over transaction identifiers, and a cursor that is either
    untouched, part-way through a window, or carried through a point
  - A cursor part-way through replays **that** window rather than computing a
    new one, which is what lets a failed run be finished rather than repeated
  - A tenant never exported starts below every identifier
  - Done when the transitions are exercised in isolation, including a replay,
    and a window that ends before it starts is unrepresentable
  - _Requirements: 2.1, 2.2, 6.6_
  - _Boundary: Export domain_

- [x] 2.2 (P) Decide where a row lands, and what a reader will see in it
  - The key a movement's partition is named by, carrying the tenant and the day
    the movement was **recorded**, plus the window, so a later run adds a file
    rather than rewriting one
  - The fixed keys the catalogue is written under
  - The columns a reader gets, with both moments kept: when it happened and when
    it was recorded
  - Done when a movement that occurred on an earlier day than it was recorded
    lands in the partition of the day it was recorded, proven by a test that
    fails if the two are swapped
  - _Requirements: 1.3, 1.4, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: Export domain_

- [x] 2.3 (P) Say what a run did
  - Per tenant: carried, already up to date, or failed with a reason
  - A reason names a class of problem and never a record, a key, or another
    tenant
  - A run's overall status follows from its tenants: one failure is a failed run
  - Done when a report of four tenants with one failure reports failure and
    still names the three that succeeded
  - _Requirements: 5.3, 7.2, 7.3_
  - _Boundary: Export domain_

## 3. The seams

- [x] 3.1 Declare what persistence and storage must offer, without providing it
  - Reading the horizon and the movements inside a window; reading and moving a
    cursor in two phases; putting rows under a key and answering whether the
    destination is reachable at all
  - One way to write, not an add and a replace: object storage has no such
    distinction, and whether a write adds or replaces is decided by the key
  - Done when the use cases can be written against these and nothing in the
    application layer mentions bytes, buckets or Parquet
  - _Depends: 2.1, 2.2_
  - _Requirements: 2.1, 2.5, 2.7, 3.3_
  - _Boundary: Application ports_

- [x] 3.2 Provide the doubles the use-case tests will run against
  - In-memory cursors and windowed reads over the existing inventory store, and
    a sink that captures keys and rows
  - A sink that can be told to fail on a chosen key, because "the run died
    half-way" is the case the design exists for
  - The seam is **not** touched here. Widening it was planned for this task and
    cannot be done in halves: adding a member to the port makes every
    implementation of it incomplete at once, so the in-memory path and the real
    path have to land together — and the real one constructs repositories that
    do not exist until 4.1 and 4.2. Moved to 4.4, which is still before the use
    cases that need it
  - Done when the doubles round-trip a cursor and a window on their own, with no
    database and no emulator running
  - _Depends: 3.1_
  - _Requirements: 6.6_
  - _Boundary: In-memory adapters_

## 4. Reading and writing for real

- [x] 4.1 (P) Read the horizon, and the movements below it
  - The horizon is the transaction identifier below which nothing is still in
    flight; movements are read as a half-open window against it
  - Done when a movement inserted by a transaction that is still open is absent
    from the window, and present in the next one after it commits
  - _Depends: 1.1, 3.1_
  - _Requirements: 2.1, 2.5, 2.6, 2.7_
  - _Boundary: PostgreSQL adapters_

- [x] 4.2 (P) Keep each tenant's position, in two phases
  - The target of a run is recorded before anything is written and confirmed
    after; a run that dies leaves the window recorded rather than lost
  - Done when a cursor left part-way through is read back as exactly the window
    that was being attempted, and a confirmed one as the point carried through
  - _Depends: 1.2, 3.1_
  - _Requirements: 2.2, 6.3_
  - _Boundary: PostgreSQL adapters_

- [x] 4.3 (P) Turn rows into a columnar object and put it where it belongs
  - Encode rows with their types intact, and put the object under the given key
  - Answer, before a run touches a tenant, whether the destination exists and
    the credentials are accepted
  - Done when an object written by this adapter is read back by an independent
    reader with a quantity that is a number and a moment that is a moment, and
    an unreachable destination is refused before anything is written
  - _Depends: 1.3, 1.4, 3.1_
  - _Requirements: 4.6, 4.7, 8.2_
  - _Boundary: Storage adapters_

- [x] 4.4 Widen the tenant-scoped seam to carry the export
  - The two new repositories join the ones the seam hands out, in **both** the
    real construction path and the in-memory one, in one change
  - A port cannot be widened in halves: adding a member makes every
    implementation incomplete at once. It is also deliberately after the
    repositories exist, because the real seam constructs them
  - Done when an export reads a tenant's movements through the same seam a
    request uses, with row-level security applying unchanged, and a use-case
    test reaches the same repositories through the in-memory one
  - _Depends: 4.1, 4.2, 3.2_
  - _Requirements: 7.1_
  - _Boundary: Integration — persistence seam_

## 5. The work itself

- [ ] 5.1 Carry one tenant
  - Read the cursor; replay its window or take a new horizon; read the
    movements; write one object per day recorded; write the catalogue; confirm
    the cursor
  - Movements recorded after the run began are left for the next run
  - A tenant with nothing new writes no movement object and is reported up to
    date
  - Answers with what it carried and how far it reached, leaving the run to turn
    that into a report — so this task needs nothing from 2.3
  - The catalogue is written whole every run, so a renamed product is named once
  - Done when a tenant with movements across three days produces three objects
    and a confirmed cursor, and running it again produces neither
  - _Depends: 3.2_
  - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.5, 3.1, 3.2, 3.3, 3.4, 5.7_
  - _Boundary: Export use cases_

- [ ] 5.2 Carry every tenant, past the one that fails
  - Ask the operator's view of the platform for the active tenants; carry each
    in its own transaction
  - Check the destination once, before the first tenant, so a bad configuration
    costs nothing
  - A tenant that fails is recorded and the run continues; its cursor keeps
    whatever it had
  - One correlation identifier travels through everything the run reports
  - Done when a run over four tenants with the second failing carries the other
    three, reports the failure by tenant, and leaves the failed tenant's cursor
    where it was
  - _Depends: 5.1, 2.3_
  - _Requirements: 1.1, 1.5, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 7.4_
  - _Boundary: Export use cases_

## 6. Wiring

- [ ] 6.1 Give the operator a command, and the application a module
  - Bind the ports to the adapters; import the feature into the application
  - A command that runs a full export, or one named tenant, with no interactive
    input, and exits reporting success only if every tenant was carried
  - Done when the command runs against the local stack end to end, prints a
    report per tenant, and returns a non-zero status when any tenant failed
  - _Depends: 5.2, 4.4, 4.3_
  - _Requirements: 5.1, 5.2, 5.4, 5.5_
  - _Boundary: Integration — module and entry point_

## 7. Proving the properties, not the happy path

Each writes its own spec file. Four tasks appending to one file are not parallel
however unrelated their assertions are.

- [ ] 7.1 (P) Show that a concurrent insert is never skipped
  - Hold a transaction open having inserted a movement; let a second movement be
    recorded and committed while it is held; run an export
  - The second movement must **not** be carried yet, and after the first commits
    both must be carried, each exactly once
  - This is the test the whole cursor design exists for; without it the design
    is a claim. It must be shown to fail when the horizon comparison is replaced
    by a plain maximum
  - Done when it passes with the horizon and fails without it
  - _Depends: 6.1_
  - _Requirements: 2.6, 2.7_
  - _Boundary: Integration suite_

- [ ] 7.2 (P) Show that what was written can actually be read
  - Objects land under a key naming the tenant and the day recorded, and an
    independent reader gets the rows back with their types intact
  - A backdated movement appears in the partition of the day it was recorded,
    beside a file an earlier run wrote, with that file untouched
  - A renamed product reads once and currently; a tenant with no catalogue reads
    as no entries; a failed catalogue write leaves the previous one readable
  - Done when every assertion above holds against the emulator and the reader is
    not the library that wrote the file
  - _Depends: 6.1_
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.6, 4.7_
  - _Boundary: Integration suite_

- [ ] 7.3 (P) Show that a failed run finishes rather than repeats
  - A run whose sink fails part-way, then a second run: every movement appears
    exactly once, under the same keys the failed run was writing
  - A tenant that fails does not stop the others, and its cursor does not move
  - An unreachable destination stops the run before any tenant is touched
  - Requests to the running application are still answered while an export is in
    flight, asserted against the real application rather than reasoned about
  - Done when the second run writes the same keys as the first attempted, and
    the whole thing fails if objects are named by run instead of by window
  - _Depends: 6.1_
  - _Requirements: 2.3, 2.4, 2.8, 5.6, 6.1, 6.2, 6.4, 6.5, 6.6_
  - _Boundary: Integration suite_

- [ ] 7.4 (P) Show that no tenant appears under another's name
  - Two tenants holding the same SKU export to two sets of objects, and neither
    tenant's rows appear under the other's prefix
  - A failure naming one tenant says nothing about any other
  - Done when reading every object under one tenant's prefix yields only that
    tenant's movements, compared against what the database says that tenant has
  - _Depends: 6.1_
  - _Requirements: 1.2, 4.5, 7.1, 7.2, 7.3_
  - _Boundary: Integration suite_

## Implementation Notes

### 1.1 An index written for this export is not the one it uses

`inventory-sync-api` added `stock_movements_tenant_recorded_idx` on
`(tenant_id, recorded_at)` with the comment "what a later incremental export
will walk". It is not: the export walks `(tenant_id, recorded_xid)`, because a
moment cannot express the point below which nothing is still in flight. Both
indexes now exist and only one has a reader. Left in place — removing an index
belongs to a task that says so — and recorded in that spec's notes as a fired
revalidation trigger.

### 1.1 The migrations are numbered in landing order

The design named the cursor table 0014 and the movement column 0015. They land
the other way round, because a cursor is meaningless without something to
compare against. The design's file plan was corrected rather than the order
bent to match it.

### 1.2 A probe left the database ahead of its migrations

Dropping the pending-pair constraint to check that the test bites left a row
that violated it, so re-adding the constraint failed — and the schema sat
without it until that was noticed. `resetDatabase` runs *before* each test, by
design, so the last test's rows outlive the suite. Any probe that drops a
constraint has to truncate before restoring it.

That prompted a check worth keeping: the whole migration chain was applied to a
fresh, empty database to prove it works from zero, not only as a delta on a
database that already had eleven migrations in it. It does.

### Outside this task's boundary, and said out loud

`inventory-throttling.integration-spec.ts` got a suite-level timeout. Every test
in it spends a sixty-request allowance and one of them pays for an Argon2 hash;
that is seconds of honest work which sat under Jest's five-second default only
while the machine was quiet. With the emulator now running alongside, it tipped
over and took four other tests down with it through a deadlocked `TRUNCATE`.
Nothing to do with this task, but a verification run cannot be trusted while it
is flaky, so it was fixed rather than re-run until green.

One full integration run in this session failed a single unidentified test and
was green on the two runs after it. It is recorded here rather than dismissed:
if it reappears, this is the second sighting, not the first.

### 1.4 The import survives compilation; it does not survive Jest

The design's reasoning was right and incomplete. `module: nodenext` emits the
dynamic import **unchanged** into the CommonJS output — confirmed by reading
`dist/adapters/storage/parquet-runtime.js`, which still says
`import('hyparquet-writer')` — and Node 22 runs it with no flag at all. The
compiled round trip works.

**Jest is the one that cannot**: its VM refuses a dynamic import without
`--experimental-vm-modules`, and that is a property of the test runner, not of
the code or the runtime. `createRequire` does not help — Jest patches the module
registry, so a "real" require lands back in Jest's CommonJS loader and tries to
parse an ES module as script.

So the four test scripts now run Jest through `node --experimental-vm-modules`.
CI calls `pnpm test` and `pnpm test:integration`, so it inherits the change. The
production entry point needs nothing.

This is exactly what the task was for: had it been discovered inside task 4.3,
it would have arrived wearing a costume — an adapter, a use case and a run
around it — and looked like a bug in the sink.

### 1.4 The reader is a second library on purpose

`readParquet` has no production caller and is not dead code: a round trip
written and read by the same library proves nothing about the file an
analytical engine will meet. `hyparquet` reads what `hyparquet-writer` wrote,
and the integration suites in group 7 read the real objects with it.

### 1.3 The destination refuses to be a real account

Requirement 8.3 says the export targets the local emulator. Enforced rather than
assumed: an endpoint whose host is not the emulator is refused at load. A `.env`
copied from somewhere with real values fails at startup instead of writing one
tenant's history somewhere it cannot be taken back from. If a real deployment is
ever wanted, that is a deliberate change to this function, which is the point.

### A patch that did not apply, again

The second of two edits to `parquet-runtime.ts` silently matched nothing,
because `pnpm lint --fix` had reformatted the block between writing and
patching. The lint error it was meant to fix stayed, which is the only reason it
was noticed. Read the file text after any tool that reformats, before patching
it — the same trap recorded in `inventory-sync-api`'s notes.

### 2.2 A tenant has no single prefix, and that is the right layout

The key is `movements/tenant_id=…/recorded_date=…`, dataset first. A query engine
points one table at one prefix and reads partition values out of the path below
it, so `movements/` has to hold movements and nothing else, with the tenant as a
partition of that table. Tenant-first reads more naturally and would force
either a table per tenant or a table whose location mixes three datasets.

The consequence is real and worth carrying forward: **everything of one tenant
is three prefixes, not one.** Task 7.4, which sweeps a tenant's objects, has to
ask for all three, and a test that asks for one would pass while proving a third
of what it claims.

A test in this task asserted the opposite — that a key starts with a tenant
prefix — and failed. The code was right and the test was wrong, which is worth
recording because it is the less common way round.

### 2.2 The tenant identifier is checked before it becomes a path

A key is a path, and a tenant carrying a `/` or a `..` would write into a prefix
that is not its own. That is the one way this design could cross tenants with
every query being correct, so `tenantSegment` refuses anything that is not a
plain identifier.

### 2.1 An empty window is not a window

"Nothing to carry" is the absence of a window, not a window of zero width. The
constructor refuses `from == to`, so the only way to express it is
`decision: 'up-to-date'` — which is what stops a run writing an object for no
rows and, worse, naming it after a range no movement is in.

The cursor also refuses a horizon that has moved backwards after a finished run.
Nothing legitimate does that; it means a restored database or a cursor from
another world, and carrying a window backwards would rewrite objects that
already exist holding something else.

### 2.3 The report is read by someone entitled to every tenant

Which is exactly why a failure reason names a class of problem and never a
record: the operator running the export acts for the whole platform, and a
reason carrying a SKU or an object key would put one tenant's contents in front
of them for no reason. Asserted by a test that stringifies the whole report and
looks for the shapes that must not be in it.

### The columnar types live in the domain, once

`parquet-runtime.ts` had its own copy of the column-type union. Two lists that
must agree eventually disagree, so the adapter now imports `ExportedColumn` from
the domain — which is also the layer the contract belongs to, since steps 7 and
8 read those column names.

### 3.2 A port cannot be widened in halves

The plan had the in-memory seam widened here and the real one in 6.1. That is
not implementable: adding a member to `TenantScopedRepositories` makes **every**
implementation of it incomplete at once, so `tsc` fails on the PostgreSQL path
the moment the in-memory path is filled. The two are one atomic change.

And it has to happen before the use cases, because a use case reaches
persistence only through the seam — so it cannot wait for group 6 either. Moved
to **4.4**, immediately after the repositories it constructs and before the use
cases that consume it. The old 6.2 became 6.1.

Second instance of the same shape in two features: in `inventory-sync-api` the
seam produced a task-graph cycle at 1.3, fixed the same way. Worth saying plainly
for the next feature that touches it: **the tenant-scoped seam is always its own
task, and it always lands after the adapters and before the use cases.**

### 3.2 A double looser than the database hides the bug it exists to catch

Movements recorded in one call share one transaction identifier, because they
are one transaction. The first version of that test asserted that a window
covering both returns both — which is **also true** when rows are numbered
individually, so the probe walked straight through it and the test proved
nothing.

What separates the two models is how far the horizon moves: one call advances it
by exactly one. Rewritten that way, the probe bites. Third instance of the rule
that a probe which fails nothing is a claim about the probe until it has been
read.

### 3.1 The rows are type aliases, not interfaces

An interface has no implicit index signature, so it cannot be handed to an
encoder that takes a record of columns without a cast — and that cast is the
kind that stays right until somebody adds a field. Written as type aliases, the
assignment is checked.

### 4.1 The horizon, proven where it is decided

The experiment from `research.md` §1 is now a test: one transaction inserts and
is held open while a second inserts and commits, taking a higher identifier but
committing first. Neither is carried — the visible one is above the horizon
*because* the invisible one is below it and still open — and after the first
commits, both are carried, each exactly once.

Replacing the horizon with `max(recorded_xid) + 1` fails both of those tests and
nothing else, which is exactly the shape of a silent data loss: eight tests stay
green while movements disappear.

### 4.3 "A moment is a moment" needs saying as "not text"

The first version parsed `occurred_at` and compared the instant. That passes
when the column is written as a **string**, because an ISO string parses back to
the right moment — so it would have accepted precisely the file this feature
exists not to write. Asserting `typeof` is not `'string'` first makes the probe
bite: typing the column as STRING now fails four tests instead of none.

Fourth instance of the rule, and the second in two tasks.

### 4.3 `forcePathStyle` is not optional against the emulator

The emulator addresses buckets by path; a virtual-host style request resolves to
nothing at all. It is set in the one place that constructs the client.

### 4.2 An unnecessary cast was removed by the linter, correctly

`file.rows as readonly ColumnarRow[]` was written defensively and `--fix`
deleted it: `ExportedRow` is already assignable, because the row shapes are type
aliases rather than interfaces (see 3.1). The cast would have been the kind that
stays right until somebody adds a field.

### 4.4 The seam widened in one change, and the rollback came free

Port and both construction paths in a single edit, as 3.2 established it has to
be. What was worth asserting beyond "the repositories are handed out" is that
the seam opens **one** transaction: a run that moves the cursor and then dies
leaves the cursor where it was, because the same rollback that discards its
writes discards the cursor move.

That makes "the cursor moved but the objects did not" a state the database
cannot hold — for anything inside the transaction. Objects in storage are
outside it, which is exactly why the cursor is two-phase: the part that cannot
be rolled back is the part the replay handles.

Two probes: removing the export repositories from the real seam fails two tests,
and removing `set_config('app.current_tenant')` fails all four — the second is
the one that matters, because it shows the isolation here is the policy's and
not a predicate this feature wrote for itself.
