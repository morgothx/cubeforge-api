-- The identifier an incremental export compares against.
--
-- `recorded_at` cannot be the cursor. It defaults to `now()`, which in
-- PostgreSQL is the moment the *transaction began*, and two concurrent inserts
-- commit in whatever order they finish. A cursor holding "the greatest
-- `recorded_at` exported" therefore skips — permanently and silently — any
-- movement whose transaction started earlier and committed later.
--
-- A transaction identifier has the property the cursor needs: an export can ask
-- the database for the identifier below which nothing is still in flight, and
-- carry only what is below it. Nothing that has not yet been carried can appear
-- beneath that line afterwards.
--
-- `xid8` rather than the `xmin` system column: 64 bits carrying their epoch, so
-- comparisons are ordinary comparisons with no wraparound to reason about.
--
-- Written only by this default. A writer that could supply the value could
-- supply a wrong one, and the export would believe it.
ALTER TABLE stock_movements
  ADD COLUMN recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
--> statement-breakpoint

-- Existing rows take this migration's own identifier, which is above every
-- identifier already committed, so a first export carries the whole history
-- once and no earlier row can appear below the line later.

-- Reading the stream in export order. The tenant leads because every export
-- reads one tenant at a time; the identifier follows because that is the range.
CREATE INDEX stock_movements_export_idx
  ON stock_movements (tenant_id, recorded_xid);
