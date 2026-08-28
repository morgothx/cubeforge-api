# Research — s3-data-export

Discovery type: **full**. The feature introduces the first code on this platform
that writes to object storage, the first dependency outside the transactional
stack, and an incremental-extraction problem whose failure mode is silent data
loss. Two of the findings below were settled by running an experiment rather
than by reading documentation.

## 1. The watermark problem, and why a timestamp cannot be the cursor

Requirement 2.6 says the export must not skip a movement whose recording time is
earlier than one already exported but which became visible later. That is not a
hypothetical: `recorded_at` defaults to `now()`, which in PostgreSQL is the
**transaction start time**, and two concurrent inserts commit in whatever order
they finish. A cursor holding "the greatest `recorded_at` exported so far"
therefore skips, permanently and silently, any row whose transaction started
earlier and committed later.

**Investigated:** the transaction-id horizon. `pg_current_snapshot()` reports the
snapshot a statement sees, and `pg_snapshot_xmin` of it is the id below which no
transaction is still in flight. A row is safe to export once its own transaction
id is **below that horizon**, because no transaction that could still produce a
lower id remains open.

**Experiment** (run against the local PostgreSQL 17, 2026-08-28). A table with
`x xid8 NOT NULL DEFAULT pg_current_xact_id()`. Session A opened a transaction,
inserted, and held it. Session B then inserted and committed immediately, taking
a *higher* id.

| Moment | horizon | row A (77517) | row B (77518) |
|---|---|---|---|
| A still in flight | 77517 | not yet visible | visible, **held back** |
| after A committed | 77519 | exported | exported |

B is visible to a reader and is deliberately **not** exported while A is open —
which is exactly the row a timestamp cursor would have exported, moving the
watermark past A forever. After A commits, both are exported, each once.

**Implication:** the cursor is an `xid8` value, and the window is half-open
`[exported_through, horizon)`. `stock_movements` gains a `recorded_xid xid8
NOT NULL DEFAULT pg_current_xact_id()` column so the comparison is a plain
64-bit one with no wraparound to reason about. `xid8` is monotonic and carries
its epoch, unlike the 32-bit `xmin` system column.

**Cost accepted:** a movement is exportable only after every transaction that
began before it has finished. A long-running transaction delays the export of
rows committed after it. This is the correct trade: late is recoverable, skipped
is not.

## 2. Exactly-once across a failed run

A cursor that advances only on success is not enough on its own: a run that
wrote three files and then failed would, on retry, write the same rows again
under different object names, because the second run computes a different
horizon.

**Investigated:** two-phase cursor. The intended target horizon is recorded
before anything is written; a retry re-uses the recorded target rather than
taking a new one, so it writes the **same rows under the same object keys**, and
the second write overwrites the first with identical content. Object names carry
the window (`<from>-<to>.parquet`) rather than a run identifier, which is what
makes them deterministic. This leans on the append-only guarantee of
`inventory-sync-api`: the rows in a fixed id window never change, so rewriting
the same key is rewriting the same bytes.

**Experiment:** putting the same key twice into the local emulator leaves one
object. Confirmed 2026-08-28.

## 3. The local emulator does what this design needs

Against Floci on `localhost:4566` with throwaway credentials: bucket creation,
`PutObject` under a Hive-style key
(`movements/tenant_id=…/recorded_date=…/1-2.parquet`), `ListObjectsV2` by
prefix, and overwrite-in-place all behaved as the design assumes. Hive-style
partition names are used because that is what a query engine discovers
partitions from in step 7; nothing in this feature depends on them.

## 4. Writing Parquet from Node — build vs adopt

Building a Parquet writer is out of the question; the question was which to
adopt.

| Candidate | Latest | Dependencies | Verdict |
|---|---|---|---|
| `hyparquet-writer` | 0.16.8, 2026-08-27 | 1 (`hyparquet`) | **Adopted** |
| `@dsnp/parquetjs` | 1.9.3, 2026-08-27 | 8, incl. its own `@aws-sdk/client-s3`, `brotli-wasm`, `bson`, thrift | Rejected |
| `parquet-wasm` | 0.7.2, 2026-06-29 | 0, but needs Apache Arrow to be useful | Rejected |
| `parquetjs` | 0.11.2, 2022 | — | Unmaintained |

**Why not `@dsnp/parquetjs`,** which is the more established name: its current
release declares `engines.node >= 24.18.0`, and both repositories in this
workspace pin Node 22 LTS. Adopting it means either pinning to 1.8.8 — the last
release that admits Node 18+ — or moving the whole workspace to Node 24, which
is not this feature's decision to make. Its dependency tree also pulls a second
copy of the AWS SDK and a WebAssembly compression library into a project whose
steering makes a point of a small, reviewed dependency graph.

**Why not `parquet-wasm`:** faster and more memory-efficient, and both matter at
a volume this project does not have. It is only worth its bundle when the data
is already in Apache Arrow, which would be a second large dependency.

**The cost of `hyparquet-writer`:** it is ESM-only and buffers a whole file in
memory rather than streaming. Node 22.12 and later can `require` an ES module,
and the repository compiles with `module: nodenext`, so the import works from
this CommonJS codebase; it is confined to one adapter file either way. Buffering
is acceptable because a file here is one tenant's movements for one day within
one window — bounded by the day's activity, not by history. **If that stops
being true**, the revalidation trigger is written into the design.

## 5. Which database identity reads the data

No new identity. Listing tenants is an operator act and `PlatformUnitOfWork`
already offers `tenants.list()`; reading one tenant's rows goes through
`TenantScopedUnitOfWork.runInTenant`, so row-level security applies to the
export exactly as it applies to a request. Requirement 7.1 is then inherited
rather than re-implemented, and the export cannot become the first reader that
steps around the seam (9.7).

A fifth identity was considered and rejected: it would need its own policies on
three tables, and the isolation proof would start over.

## Synthesis

**Generalization.** Movements and the catalogue look like two features and are
one: *write a set of rows as a columnar object under a deterministic key*. The
difference is only which key and whether the previous object is replaced. One
sink interface serves both, and step 7 will add datasets to it rather than
adding pipelines.

**Build vs adopt.** Adopted: `hyparquet-writer` for Parquet,
`@aws-sdk/client-s3` for object storage. Built: the cursor, the windowing and
the report — none has an off-the-shelf answer that fits a tenant-scoped seam,
and a change-data-capture product would be an order of magnitude more machinery
than nightly extraction of an append-only table needs.

**Simplification.** Three ports collapsed into one. An `ObjectStore` port and a
`ColumnarWriter` port would each have exactly one real implementation and would
force the application layer to know that a file is bytes; `ExportSink` takes
rows and a key. The test double captures rows, and the integration tests read
the real objects back with `hyparquet`, which is a stronger check than any fake
would be.

## Risks

- **A long-running transaction stalls the export.** By design (finding 1). The
  report says how far each tenant reached, so a stall is visible rather than
  silent.
- **A partition day accumulates one small file per run.** Acceptable at this
  volume; compaction is named out of scope in requirements, and the trigger for
  revisiting it is written into the design.
- **`hyparquet-writer` is a young library** (0.x). It is confined to one adapter
  behind one interface, and the integration tests read its output with an
  independent reader, so a defect surfaces in this repository rather than in a
  chart six months later.

## Revalidation triggers

- A movement becoming amendable or removable, which would break the deterministic
  rewrite in finding 2.
- Any dataset whose single-run output stops fitting comfortably in memory.
- More than one export running at a time.
- A consumer reading the exported objects by a name this design chose, rather
  than through the catalogue that step 7 will define.
