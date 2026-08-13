-- Runtime identities, their grants, and row-level security.
--
-- This migration is the second of the two independent isolation layers. The
-- first is the explicit tenant predicate the repositories write. This one holds
-- even when that predicate is missing, which is the whole point: the two must
-- not share a point of failure.
--
-- Role names are fixed here because they are structural. Their passwords are
-- not: those are set by `pnpm db:bootstrap` from the environment, so no secret
-- ever enters version control.

-- Roles are created without login; the bootstrap script grants LOGIN together
-- with the password. Creating them here keeps their existence and their grants
-- in the same reviewable diff.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cubeforge_app') THEN
    CREATE ROLE cubeforge_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cubeforge_operator') THEN
    CREATE ROLE cubeforge_operator NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT CONNECT ON DATABASE cubeforge TO cubeforge_app, cubeforge_operator;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO cubeforge_app, cubeforge_operator;--> statement-breakpoint

-- Enable and FORCE. Without FORCE, the table owner bypasses every policy below,
-- which would make this entire migration decorative the moment anything
-- connected as the owner.
ALTER TABLE tenants     ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenants     FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE people      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE people      FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- The current tenant, published per transaction by the unit of work. The
-- two-argument form returns NULL instead of raising when the setting is absent,
-- and NULL comparisons yield no rows — so a query issued outside a tenant
-- transaction sees nothing rather than everything. This fails closed by
-- construction.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;
--> statement-breakpoint

-- ---------------------------------------------------------------- tenants ---
GRANT SELECT ON tenants TO cubeforge_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenants TO cubeforge_operator;--> statement-breakpoint

CREATE POLICY tenants_app_read ON tenants
  FOR SELECT TO cubeforge_app
  USING (id = current_tenant_id());
--> statement-breakpoint

-- Operators administer tenants as containers. This is the only table where
-- they can read rows.
CREATE POLICY tenants_operator_all ON tenants
  FOR ALL TO cubeforge_operator
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ------------------------------------------------------------ memberships ---
GRANT SELECT, INSERT, UPDATE ON memberships TO cubeforge_app;--> statement-breakpoint

-- Deliberately no grant for cubeforge_operator. Requirement 3.2 is enforced by
-- the absence of privilege, not by the application declining to ask: an
-- operator session cannot read a membership even with hand-written SQL.
CREATE POLICY memberships_app_all ON memberships
  FOR ALL TO cubeforge_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

-- ----------------------------------------------------------------- people ---
GRANT SELECT, INSERT ON people TO cubeforge_app;--> statement-breakpoint
GRANT UPDATE (status) ON people TO cubeforge_operator;--> statement-breakpoint

-- A tenant only sees the people who belong to it. Membership rows consulted
-- here are the current tenant's own, so this discloses nothing across tenants.
CREATE POLICY people_app_read ON people
  FOR SELECT TO cubeforge_app
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.person_id = people.id
        AND m.tenant_id = current_tenant_id()
    )
  );
--> statement-breakpoint

CREATE POLICY people_app_insert ON people
  FOR INSERT TO cubeforge_app
  WITH CHECK (true);
--> statement-breakpoint

-- Operators may deactivate a person platform-wide, and nothing else: the column
-- grant above limits the update to `status`, and no SELECT grant exists, so an
-- operator can neither browse people nor learn which tenants they belong to.
CREATE POLICY people_operator_update ON people
  FOR UPDATE TO cubeforge_operator
  USING (true) WITH CHECK (true);
