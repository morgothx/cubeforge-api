-- Lets the caller supply the creation time, so the application clock is the
-- single authority on when a record came into being.
--
-- Without this the person lookup fell back to the column default while tenants
-- and memberships took their timestamp from the clock the use cases inject.
-- One entity keeping its own time makes creation timestamps untestable and the
-- ordering between the three tables meaningless.
--
-- The argument list changes, so this is a different function rather than a
-- replacement: the two-argument version has to be dropped explicitly.

DROP FUNCTION IF EXISTS find_or_create_person(uuid, citext);--> statement-breakpoint

CREATE FUNCTION find_or_create_person(
  p_id uuid,
  p_email citext,
  p_created_at timestamptz
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  -- Pinned so the function cannot be hijacked by a caller-controlled
  -- search_path, which is the standard hazard of SECURITY DEFINER.
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Upsert rather than select-then-insert: the conflicting branch is resolved
  -- by the database, so two concurrent requests for the same new address cannot
  -- race into a duplicate-key failure. The conflict branch needs the owner
  -- UPDATE policy from migration 0002.
  INSERT INTO people (id, email, created_at)
  VALUES (p_id, p_email, p_created_at)
  ON CONFLICT (email) DO UPDATE SET email = people.email
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION find_or_create_person(uuid, citext, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_or_create_person(uuid, citext, timestamptz) TO cubeforge_app;
