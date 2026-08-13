-- Lets the migration identity manage operator status.
--
-- This is the root of trust for the whole platform: requirement 11.5 says the
-- API offers no way to grant operator status, so the first operator — and every
-- later one — is created by whoever already controls the database. That is the
-- migration identity, not a superuser, so the act is available wherever
-- migrations run rather than only on a developer's machine.
--
-- Owning the table is not enough. FORCE ROW LEVEL SECURITY subjects the owner
-- to policies like anyone else, which is the same lesson migration 0002 records
-- for `people`.

CREATE POLICY platform_operators_owner_read ON platform_operators
  FOR SELECT TO cubeforge_migrator USING (true);
--> statement-breakpoint
CREATE POLICY platform_operators_owner_insert ON platform_operators
  FOR INSERT TO cubeforge_migrator WITH CHECK (true);
--> statement-breakpoint
-- Withdrawing operator status is a deletion rather than a status column: unlike
-- a membership, the record attributes no historical data, so there is nothing
-- to retain by keeping it.
CREATE POLICY platform_operators_owner_delete ON platform_operators
  FOR DELETE TO cubeforge_migrator USING (true);
