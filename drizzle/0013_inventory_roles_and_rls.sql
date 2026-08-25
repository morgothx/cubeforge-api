-- Row-level security for the inventory tables, and the grants that make the
-- movement stream append-only.
--
-- No new role. Inventory is tenant-owned work under the tenant the request
-- names, which is exactly what `cubeforge_app` already is. A fourth identity
-- existed for authentication because the tenant was the answer rather than the
-- question; here the tenant is published before the first statement runs.
--
-- The append-only guarantee is a *missing grant*, not a missing method. A
-- repository can grow an `update` later by somebody who did not read this file;
-- a privilege cannot be forgotten into existence.

-- Enable and FORCE. Without FORCE the owner bypasses every policy below, and
-- the policy-coverage test would still pass while the protection was
-- decorative.
ALTER TABLE inventory_products  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_products  FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_locations FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_movements     ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_movements     FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- ------------------------------------------------------ inventory_products ---
-- Read, declare, and re-declare. No DELETE: movements already recorded point at
-- these rows, and a catalogue that can lose an entry is a history that stops
-- being readable.
GRANT SELECT, INSERT, UPDATE ON inventory_products TO cubeforge_app;--> statement-breakpoint

CREATE POLICY inventory_products_app_all ON inventory_products
  FOR ALL TO cubeforge_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

-- ----------------------------------------------------- inventory_locations ---
GRANT SELECT, INSERT, UPDATE ON inventory_locations TO cubeforge_app;--> statement-breakpoint

CREATE POLICY inventory_locations_app_all ON inventory_locations
  FOR ALL TO cubeforge_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

-- --------------------------------------------------------- stock_movements ---
-- SELECT and INSERT only. **No UPDATE and no DELETE, deliberately.** A movement
-- is never corrected in place; a mistake is offset by another movement, so the
-- error stays visible beside its correction. This is also what lets a later
-- incremental export trust that a row it has already written will not change
-- underneath it.
GRANT SELECT, INSERT ON stock_movements TO cubeforge_app;--> statement-breakpoint

-- Two policies rather than one FOR ALL, so the absence of an update path is
-- stated twice: once by the missing grant, once by there being no policy that
-- would permit it even if the grant were restored by accident.
CREATE POLICY stock_movements_app_read ON stock_movements
  FOR SELECT TO cubeforge_app
  USING (tenant_id = current_tenant_id());
--> statement-breakpoint

CREATE POLICY stock_movements_app_insert ON stock_movements
  FOR INSERT TO cubeforge_app
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
