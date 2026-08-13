-- Lets the authenticating identity read people.
--
-- Signing in starts from an email address and has to produce a person and their
-- status; refreshing starts from a token and has to know whether that person
-- was deactivated. Neither is possible without reading `people`, and the design
-- did not account for it — the grant table listed only the credential tables.
--
-- The read is unrestricted, and that is the honest shape: authentication is
-- platform-wide by nature, and a policy keyed on a tenant would be meaningless
-- for an identity that has no tenant. What contains it is that this role serves
-- no request other than authentication, and holds no grant on any tenant-owned
-- table.
GRANT SELECT ON people TO cubeforge_authenticator;--> statement-breakpoint

CREATE POLICY people_authenticator_read ON people
  FOR SELECT TO cubeforge_authenticator
  USING (true);
