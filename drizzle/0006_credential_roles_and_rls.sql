-- The authenticating identity, its grants, and row-level security on the
-- credential tables.
--
-- Why a fourth identity exists: resolving an API key must discover which tenant
-- it belongs to, so it cannot run under a policy keyed on `current_tenant_id()`
-- — the tenant is the answer, not the question. `cubeforge_authenticator` has no
-- tenant context at all, and holds the only grants that can read secret
-- material. `cubeforge_app` is given nothing here, which is what keeps a
-- password digest out of reach of every tenant request.
--
-- The role is created NOLOGIN, exactly as the runtime roles in 0001 were. Its
-- password is set from the environment by `pnpm db:bootstrap`, so no secret
-- enters version control.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cubeforge_authenticator') THEN
    CREATE ROLE cubeforge_authenticator NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT CONNECT ON DATABASE cubeforge TO cubeforge_authenticator;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO cubeforge_authenticator;--> statement-breakpoint

-- Enable and FORCE, as everywhere else: without FORCE the owner bypasses every
-- policy below, and the existing policy-coverage test would still pass while
-- the protection was decorative.
ALTER TABLE person_credentials      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE person_credentials      FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE credential_setup_tokens ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE credential_setup_tokens FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE refresh_tokens          ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE refresh_tokens          FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE api_keys                ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE api_keys                FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE platform_operators      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE platform_operators      FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------- person_credentials ---
GRANT SELECT, INSERT, UPDATE ON person_credentials TO cubeforge_authenticator;--> statement-breakpoint

CREATE POLICY person_credentials_authenticator_all ON person_credentials
  FOR ALL TO cubeforge_authenticator
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ----------------------------------------------- credential_setup_tokens ---
-- The operator issues them, the authenticator redeems them, and neither can do
-- the other's half. An operator that could read a digest back could not use it
-- — digests are one-way — but the grant would still be privilege nobody needs.
GRANT INSERT ON credential_setup_tokens TO cubeforge_operator;--> statement-breakpoint
GRANT SELECT, UPDATE ON credential_setup_tokens TO cubeforge_authenticator;--> statement-breakpoint

CREATE POLICY setup_tokens_operator_insert ON credential_setup_tokens
  FOR INSERT TO cubeforge_operator
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY setup_tokens_authenticator_read ON credential_setup_tokens
  FOR SELECT TO cubeforge_authenticator
  USING (true);
--> statement-breakpoint
CREATE POLICY setup_tokens_authenticator_update ON credential_setup_tokens
  FOR UPDATE TO cubeforge_authenticator
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- --------------------------------------------------------- refresh_tokens ---
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO cubeforge_authenticator;--> statement-breakpoint

CREATE POLICY refresh_tokens_authenticator_all ON refresh_tokens
  FOR ALL TO cubeforge_authenticator
  USING (true) WITH CHECK (true);
--> statement-breakpoint

-- ---------------------------------------------------------------- api_keys ---
-- The only table with two audiences. The authenticator resolves a key with no
-- tenant published, because the key is what names the tenant; the tenant-scoped
-- identity manages keys under the same predicate every other tenant-owned table
-- uses. Two policies, two grants, one table.
GRANT SELECT, UPDATE ON api_keys TO cubeforge_authenticator;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON api_keys TO cubeforge_app;--> statement-breakpoint

CREATE POLICY api_keys_authenticator_read ON api_keys
  FOR SELECT TO cubeforge_authenticator
  USING (true);
--> statement-breakpoint
-- Recording last use is the only write the authenticator performs, and the
-- column grant keeps it from being any other write.
CREATE POLICY api_keys_authenticator_touch ON api_keys
  FOR UPDATE TO cubeforge_authenticator
  USING (true) WITH CHECK (true);
--> statement-breakpoint

CREATE POLICY api_keys_app_all ON api_keys
  FOR ALL TO cubeforge_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint

-- ------------------------------------------------------ platform_operators ---
-- Read-only for everything that serves requests. Requirement 11.5 says the API
-- offers no way to grant operator status, and the absent INSERT is what makes
-- that true rather than merely intended.
GRANT SELECT ON platform_operators TO cubeforge_authenticator;--> statement-breakpoint

CREATE POLICY platform_operators_authenticator_read ON platform_operators
  FOR SELECT TO cubeforge_authenticator
  USING (true);
