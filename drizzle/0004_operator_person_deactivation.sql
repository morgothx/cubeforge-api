-- Replaces the operator's direct UPDATE on `people` with a function that does
-- exactly one thing.
--
-- Why: `GRANT UPDATE (status)` alone cannot express what requirement 8.1 needs.
-- Deactivating one person requires `WHERE id = ...`, and a WHERE clause reads a
-- column, which requires SELECT privilege on it. The operator holds no SELECT
-- grant on `people` on purpose, so every targeted update failed with
-- "permission denied for table people" — while `UPDATE people SET status = ...`
-- with no WHERE was accepted. Verified against the running database.
--
-- The alternatives were to grant the operator SELECT on `people`, which would
-- expose every address on the platform to an actor that requirement 3.3 says
-- must learn nothing, or this: one function, no arguments beyond the
-- identifier, returning nothing. It discloses nothing at all — not even whether
-- the person exists, which is precisely what 3.3 asks for.

CREATE FUNCTION deactivate_person(p_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  -- Pinned, as with every SECURITY DEFINER function here.
  SET search_path = public, pg_temp
  AS $$
BEGIN
  -- Relies on the owner UPDATE policy from migration 0002: FORCE ROW LEVEL
  -- SECURITY subjects the owner to policies, so running as the owner is not by
  -- itself enough.
  UPDATE people SET status = 'deactivated' WHERE id = p_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION deactivate_person(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION deactivate_person(uuid) TO cubeforge_operator;--> statement-breakpoint

-- With the function in place the direct privilege is not merely unused, it is a
-- second way in. Removing it leaves exactly one route, which is the one the
-- policies and grants above describe.
REVOKE UPDATE ON people FROM cubeforge_operator;--> statement-breakpoint
DROP POLICY IF EXISTS people_operator_update ON people;
