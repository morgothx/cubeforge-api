-- Lets the authenticating identity read one person's memberships, and only
-- theirs, across every tenant.
--
-- No existing identity could answer "where does this caller belong". The app
-- identity holds the grant but `memberships_app_all` pins it to one tenant per
-- transaction, and knowing which tenants to iterate is the question being
-- asked. The operator identity has no grant at all, and migration 0001 says
-- that absence is the point.
--
-- The mechanism is the one this schema already uses for tenants, applied to a
-- person: publish the subject into the transaction, and let a policy do the
-- confining. The alternative considered was a `SECURITY DEFINER` function,
-- which works and is already established here for `find_or_create_person` —
-- but it moves the confinement into a function body, where a later edit can
-- widen it without touching anything that looks like a policy.
--
-- What makes requirement 5.1 structural rather than conventional: a query that
-- forgets its predicate still returns only the caller's rows, because the
-- restriction is below the query rather than inside it.

-- The current person, published per transaction by the unit of work. The
-- two-argument form of `current_setting` returns NULL rather than raising when
-- the setting is absent, and NULL comparisons yield no rows — so a query
-- issued with nobody published sees nothing rather than everything. This is
-- `current_tenant_id()` with one word changed, deliberately: the two failure
-- modes should be identical so neither needs its own reasoning.
CREATE OR REPLACE FUNCTION current_person_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_person', true), '')::uuid $$;
--> statement-breakpoint

-- SELECT and nothing else. This identity serves authentication and this one
-- read; it must never write a membership, and the grant rather than a
-- convention is what says so — `INSERT` here would be refused by the database
-- even from hand-written SQL.
GRANT SELECT ON memberships TO cubeforge_authenticator;--> statement-breakpoint

-- Confined to the published person's own rows. Not to a tenant: the whole
-- purpose is to cross tenants, and this is the only read in the platform that
-- does. What keeps that from widening tenant exposure is that it selects by
-- person and returns nothing about anyone else's membership in the same
-- tenant.
CREATE POLICY memberships_authenticator_own ON memberships
  FOR SELECT TO cubeforge_authenticator
  USING (person_id = current_person_id());
