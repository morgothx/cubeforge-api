-- Where each tenant's export has reached.
--
-- No new database identity. Reading a tenant's rows is tenant-owned work under
-- the tenant the run names, which is exactly what `cubeforge_app` already is;
-- the export reaches this table through the same seam a request does, so
-- isolation is inherited rather than restated.
--
-- **Two phases, deliberately.** `exported_through` is the point carried through
-- and confirmed. `pending_from`/`pending_to` is the window a run is part-way
-- through: recorded before anything is written, cleared when it is confirmed. A
-- run that dies in between therefore leaves the window recorded, and the next
-- run finishes *that* window rather than computing a new one — which is what
-- makes the objects it writes the same objects, under the same keys, so
-- rewriting them is rewriting the same bytes.
CREATE TABLE export_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  -- `movements` today. The column exists so a second dataset is a row rather
  -- than a migration on a table that by then holds every tenant's position.
  dataset text NOT NULL,
  exported_through xid8,
  pending_from xid8,
  pending_to xid8,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT export_cursors_pkey PRIMARY KEY (tenant_id, dataset),
  -- Half a window is not a window: a start with no end is a run nobody can
  -- finish, and the next run could not tell whether to replay or to start
  -- fresh. The database refuses to hold the ambiguity.
  CONSTRAINT export_cursors_pending_pair_check
    CHECK ((pending_from IS NULL) = (pending_to IS NULL)),
  CONSTRAINT export_cursors_pending_order_check
    CHECK (pending_from IS NULL OR pending_from < pending_to)
);--> statement-breakpoint

ALTER TABLE export_cursors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Without FORCE the owner bypasses the policy below, and the platform's
-- policy-coverage test would pass while the protection was decorative.
ALTER TABLE export_cursors FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- Read, start, confirm. **No DELETE**: forgetting how far a tenant was carried
-- is not an operation this feature wants to have, and a cursor that can vanish
-- is a history that can be exported twice.
GRANT SELECT, INSERT, UPDATE ON export_cursors TO cubeforge_app;--> statement-breakpoint

CREATE POLICY export_cursors_app_all ON export_cursors
  FOR ALL TO cubeforge_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
