-- Lets the authenticating identity see whether a tenant is active.
--
-- Requirement 6.3 rejects a credential scoped to an inactive tenant, and an API
-- key is exactly that. Resolution therefore joins `tenants`, which the previous
-- migration did not anticipate — it granted `people` and stopped there.
--
-- Deciding this during resolution rather than in a caller is deliberate: a
-- revoked key and a key of a retired tenant both resolve to nothing, so no use
-- case has to remember either rule.
GRANT SELECT ON tenants TO cubeforge_authenticator;--> statement-breakpoint

CREATE POLICY tenants_authenticator_read ON tenants
  FOR SELECT TO cubeforge_authenticator
  USING (true);
