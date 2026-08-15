-- Lets the migration identity issue the very first setup token.
--
-- Migration 0007 gave it operator status to grant; this completes the act. An
-- operator recorded but unable to obtain a password is an operator who cannot
-- act: issuing a setup token requires an operator bearer token, and on an empty
-- platform there is nobody to issue one. That circle is what `bootstrap-operator`
-- breaks, and it needs this policy to do it — FORCE ROW LEVEL SECURITY applies
-- to the owner too, so owning the table grants nothing by itself.
--
-- Insert only. The migration identity may set a credential in motion and can
-- never read one back: no SELECT policy is granted here, so the digests remain
-- visible to the authenticating identity alone.

CREATE POLICY setup_tokens_owner_insert ON credential_setup_tokens
  FOR INSERT TO cubeforge_migrator WITH CHECK (true);
