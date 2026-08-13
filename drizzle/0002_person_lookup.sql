-- Resolves a person by email across the whole platform, without letting the
-- application read the people table.
--
-- Why this exists: `people.email` is unique platform-wide, but `people_app_read`
-- deliberately hides anyone who belongs only to another tenant. Without this
-- function a tenant admin adding a member whose address is already registered
-- elsewhere receives a duplicate-key error — which both makes requirement 4.2
-- impossible and discloses that the person exists somewhere else, breaking 4.3.
--
-- The function returns an identifier and nothing else: never the record, never
-- which tenants the person belongs to. The caller learns that it may now attach
-- a membership, and learns nothing about the rest of the platform.

-- SECURITY DEFINER runs as the owner, and FORCE ROW LEVEL SECURITY subjects the
-- owner to policies like anyone else. These two policies are what let the
-- function do its job. They are scoped to the migration role, which never
-- serves a request — it applies migrations and owns this function.
CREATE POLICY people_owner_read ON people
  FOR SELECT TO cubeforge_migrator USING (true);
--> statement-breakpoint
CREATE POLICY people_owner_insert ON people
  FOR INSERT TO cubeforge_migrator WITH CHECK (true);
--> statement-breakpoint
-- Required by the ON CONFLICT DO UPDATE branch below. Without it the conflict
-- path fails the policy check, which would leave exactly the case this function
-- exists to handle broken.
CREATE POLICY people_owner_update ON people
  FOR UPDATE TO cubeforge_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION find_or_create_person(p_id uuid, p_email citext)
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
  -- race into a duplicate-key failure.
  INSERT INTO people (id, email)
  VALUES (p_id, p_email)
  ON CONFLICT (email) DO UPDATE SET email = people.email
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION find_or_create_person(uuid, citext) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_or_create_person(uuid, citext) TO cubeforge_app;
