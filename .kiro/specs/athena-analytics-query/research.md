# Research — athena-analytics-query

Discovery type: **extension with a complex integration**. The codebase is
well-known and its patterns settled; what is new is an engine nothing here has
ever spoken to. So the investigation is almost entirely empirical, and every
finding below was produced by running against the local stack rather than read
in documentation.

## 1. The engine answers, and it is not the engine

The pipeline was proven end to end before any of this was designed: a catalogue
table over `movements/`, one `SELECT count(*)`, two rows back — the same two the
export had just written. Analytics over the exported objects is buildable and
testable locally.

Then four separate probes showed how far the local engine is from the one this
code will run against in a deployment.

| Probe | Locally | Real Athena | Consequence |
|---|---|---|---|
| Query a partitioned table with **no partitions registered** | Returns rows; derives `tenant_id` from the key path and filters on it correctly | Returns nothing until partitions are registered or projection is configured | The partition arrangement **cannot be validated locally at all** |
| Read `ColumnInfo` from a result | Every column reported as `varchar`, including an `int` and a `timestamp` | Reports the true types | Typing a result from what the engine says would pass in production and fail here |
| Send a query with `?` and `ExecutionParameters` | `Expected 1 parameters, but none were supplied` — the placeholder reaches the engine, the value does not | Binds the parameter | Parameter binding cannot be exercised locally |
| `SHOW PARTITIONS movements` | `Parser Error` from `floci-duck` | Supported | The dialect underneath is **DuckDB**, not Presto |

The last row is the one that explains the rest. Floci's analytics is DuckDB
reading Parquet from the object store, which is why it infers Hive partitions
from the path for free and why Athena's DDL is not available.

**This is the lesson `s3-data-export` paid for four times — a double looser than
the thing it stands for hides the bug it exists to catch — arriving at the scale
of an entire engine.** Three of the four rows above turn directly into design
decisions below, precisely so that the local engine's generosity cannot be
mistaken for correctness.

## 2. What does work, verified

- **A join across datasets**, which is what a labelled answer needs:
  `SELECT m.sku, p.name, sum(m.quantity) FROM movements m JOIN products p ON
  p.tenant_id = m.tenant_id AND p.code = m.sku ...` returned `ACME-001 / A
  widget / 8` — the 12 received minus the 4 sold.
- **Bounding a period on the partition column**, compared as a string:
  `WHERE recorded_date >= '2026-08-01' AND recorded_date <= '2026-08-31'`.
- **A result's first row is the header row**, naming the columns. Real Athena
  does this too for `SELECT`. Anything reading results has to drop it.
- **Every value arrives as a string**, on both engines. That part is not a
  fidelity gap; it is simply what the result API is.

## 3. The freshness problem, and why it reaches upstream

Requirement 3.1 asks every answer to report the moment through which it is
complete. Requirement 3.4 forbids reading the transactional database to answer.
Together they have no solution with the platform as it stands:

- The only completeness marker anywhere is `export_cursors.exported_through`.
  It is an `xid8` — **not a moment** — and it lives in PostgreSQL, on the far
  side of 3.4.
- The bucket holds three prefixes and nothing else. Nothing published by the
  export says how far it got.
- Deriving it from the data (`max(recorded_at)`) answers a different question:
  "the last movement I know about", not "complete through". A tenant with no
  activity yesterday would show a watermark that never advances, though the
  export ran every night and its answers are current.

**Decision: `s3-data-export` publishes its watermark.** That spec's own boundary
already claims the fact — it owns "how far each tenant has been carried" — and
the gap is only that it keeps it to itself. Publishing it as a fourth dataset,
one row per tenant, makes it readable by the same engine that reads everything
else and keeps the analytical path off the transactional store entirely.

This fires a revalidation trigger on a spec that is already `implemented`,
handled exactly as the precedent in this repository: `s3-data-export` added a
column to `inventory-sync-api`'s table, recorded it in that spec's notes, and
re-ran its suites. The same is done here.

## 4. Design decisions

### Generalization

The two questions — what is on hand, and what moved per day — are both an
aggregate over a tenant's movements within a bound, differing in what they group
by and whether they join the catalogue. The port is shaped as *a question with a
declared answer*, so a third question is a new declaration rather than a new
seam. The implementation stays at the two the requirements name.

### Build vs. adopt

- **Adopted: partition projection**, over registering partitions after each
  export. The keys are perfectly regular, and it removes an entire class of
  failure in which a day is exported but invisible. `tenant_id` uses the
  `injected` projection type, which has a property worth more than the
  convenience: **Athena refuses a query that does not constrain the injected
  column**. The adapter binds the tenant, and the catalogue makes a query
  without one fail — the platform's two-independent-layers rule, arriving in
  analytics without being asked for.
- **Adopted: the engine's own async execution model** — submit, poll, fetch —
  rather than any wrapper. Nothing else offers the deadline behaviour 6.2 needs.
- **Rejected: parameter binding**, because it cannot be exercised locally. The
  tenant is made safe the way `partition.ts` already makes it safe for a path:
  refused unless it is a plain UUID. That validation has a probe; a parameter
  that no local test can bind does not.
- **Rejected: typing a result from `ColumnInfo`**, because the local engine
  reports every column as `varchar`. Each question declares the shape of its own
  answer, and the decoder parses against that declaration — correct on both
  engines, and wrong loudly rather than quietly if a column moves.

### Simplification

- No caching, no pre-aggregation, no result store beyond what the engine
  requires. Nothing in the requirements asks for them and step 8 owns that
  question.
- No second implementation of the analytics port beyond the in-memory double the
  use-case tests need. The engine is not going to be swapped.
- The seam is a scoping call, not a unit of work: there is no transaction to
  open, and modelling one would suggest a rollback that does not exist.

## 5. Risks

| Risk | Why it matters | How it is handled |
|---|---|---|
| The dialect diverges | Code written for Athena is exercised on DuckDB | Every query lives in one file, restricted to the constructs both accept: `SELECT`, `JOIN`, `GROUP BY`, `SUM`, `COUNT`, string comparison, `ORDER BY`. No engine-specific functions. |
| Partition projection is unverifiable locally | A wrong arrangement passes every local test | Stated as a declared-not-verified claim in the design and in the requirements' scope boundaries; the catalogue definition is kept in one reviewable place |
| The `injected` projection makes an unfiltered query fail **only in production** | The second isolation layer has no local probe | The first layer — the adapter binding the tenant — is probed locally and is sufficient on its own; the second is recorded as belt over braces, never as the reason isolation holds |
| A query runs long | An analytical question can outlive a request | A deadline in the runner, and the query is stopped rather than abandoned |
| The upstream watermark is missed | An answer would report a freshness that is not real | Absence is a distinct, tested state (3.3), never a default moment |
