# Implementation Tasks — tenant-and-user-management

Ordering follows Foundation → Core → Integration → Validation. Task N implicitly
depends on everything before it; `_Depends:_` marks only non-obvious or
cross-group dependencies. `(P)` marks tasks safe to run concurrently with their
immediate peers.

## 1. Domain foundation

No framework, no database. Everything here is unit testable in isolation, which
is the point of keeping it separate.

- [x] 1.1 Establish identifier and role primitives
  - Define distinct identifier types for tenants, people and memberships so one
    kind cannot be passed where another is expected
  - Define the role set as admin, editor and viewer, with parsing that reports
    the permitted values when given anything else
  - Define a normalized, case-insensitive email value
  - Done when passing a person identifier where a tenant identifier is expected
    fails to compile, and rejecting an unknown role returns the permitted set
  - _Requirements: 4.5, 5.1_
  - _Boundary: Domain primitives_

- [x] 1.2 Model tenants, people and memberships
  - Represent each record with its status and creation time
  - Express deactivation as a status transition; provide no operation that
    removes a record
  - Allow one person to hold memberships in several tenants, each with its own
    role
  - Done when a deactivated entity reports inactive while retaining all its data,
    and no entity exposes a delete operation
  - _Requirements: 1.4, 2.3, 5.2, 8.2_
  - _Boundary: Domain entities_
  - _Depends: 1.1_

- [x] 1.3 Implement the unified access decision
  - Resolve tenant inactive, membership absent, membership revoked and person
    deactivated into one decision with a distinguishable reason
  - Grant access only when the tenant is active, the person is active, and an
    active membership exists for that tenant
  - Return the role from the membership in the tenant being acted on, never from
    any other membership the person holds
  - Done when each of the four refusal causes is reported distinctly to the
    caller, and a person holding admin in one tenant is refused in another
  - _Requirements: 2.2, 5.4, 6.2, 8.1, 9.1, 9.3_
  - _Boundary: Access decision_
  - _Depends: 1.2_

- [x] 1.4 (P) Implement the last-administrator invariant
  - Reject a change that would leave a tenant with no active administrator,
    whether the change is a revocation or a role change
  - Permit the same change when another active administrator remains
  - Compute the rule from a supplied count so it needs no data access
  - Done when both the revocation path and the role-change path are rejected for
    a tenant's only administrator, and both succeed when a second one exists
  - _Requirements: 7.1, 7.2_
  - _Boundary: Administration policy_
  - _Depends: 1.2_

- [x] 1.5 (P) Define the domain error union
  - Cover validation failure, duplicate tenant name, existing membership,
    invalid role, last-administrator violation, absent record and refusal
  - Keep refusal distinct from absence internally, even though both will surface
    identically to callers
  - Done when every error a use case can raise is representable, and exhaustive
    handling is enforced at compile time
  - _Requirements: 1.2, 4.4, 4.5, 7.1, 9.2_
  - _Boundary: Domain errors_
  - _Depends: 1.1_

## 2. Persistence foundation

Infrastructure prerequisites. Nothing in section 4 can be verified against a real
database until these exist.

- [x] 2.1 Wire the query builder into the application container
  - Provide a first-party module exposing a configured client, with no
    third-party integrator package
  - Read separate connection settings for the migration identity and the runtime
    identities, and validate them at startup rather than at first query
  - Configure the migration tool itself — where schema definitions live, where
    generated migrations are written, and which identity applies them
  - Document the settings in the environment example file
  - Done when the application fails to start with a clear message when a
    connection setting is missing, and starts cleanly when all are present
  - _Requirements: 9.1_
  - _Boundary: Persistence module_

- [x] 2.2 Create the schema and its migration
  - Create tables for tenants, people and memberships with status and creation
    time on each
  - Enforce unique tenant names, platform-wide case-insensitive unique emails,
    and one membership per person per tenant
  - Constrain status values without using an enum type, so new values can be
    added later
  - Done when the migration applies to an empty database and a second membership
    for the same person and tenant is rejected by the database itself
  - _Requirements: 1.4, 2.3, 4.4, 5.1_
  - _Boundary: Schema_
  - _Depends: 2.1_

- [x] 2.3 Create database roles and row-level security policies
  - Create a schema-owning migration identity, a tenant-scoped runtime identity,
    and an operator identity, granting each only what it needs
  - Enable and force row-level security on every tenant-owned table so ownership
    cannot bypass it
  - Restrict the tenant-scoped identity to rows matching the current tenant
    context; grant the operator identity nothing at all on memberships
  - Done when a query issued as the operator identity against memberships returns
    no rows regardless of what is asked, and forcing is verifiable in the
    database catalog
  - _Requirements: 3.2, 9.1, 9.3_
  - _Boundary: Schema, Database roles_
  - _Depends: 2.2_

- [x] 2.4 Build the integration test harness
  - Run migrations against the local database before the suite and reset state
    between tests
  - Provide helpers to act as a given person in a given tenant, and to act as an
    operator
  - Done when an integration test can seed two tenants with members and assert
    against them repeatably, with no leakage between tests
  - _Requirements: 9.1_
  - _Boundary: Test infrastructure_
  - _Depends: 2.3_

## 3. Contracts and test doubles

- [x] 3.1 Define the persistence and support contracts
  - Declare repository contracts for tenants, people and memberships whose
    tenant-scoped operations take no tenant argument, because the scope comes
    from the transaction
  - Declare the tenant-scoped transactional contract as the only route to
    tenant-scoped repositories, and a separate operator contract exposing no
    membership access at all
  - Declare time and identifier sources so tests are deterministic
  - Done when no tenant-scoped repository can be obtained without entering a
    tenant transaction
  - _Requirements: 3.2, 9.1_
  - _Boundary: Ports_
  - _Depends: 1.2_

- [x] 3.2 Implement in-memory adapters for the contracts
  - Satisfy every contract from 3.1 with in-memory storage, including tenant
    scoping semantics
  - Enforce the same uniqueness rules the database enforces, so use-case tests
    fail for the same reasons production would
  - Done when the full use-case suite can run with no database available
  - _Requirements: 4.4, 9.1_
  - _Boundary: In-memory adapters_
  - _Depends: 3.1_

## 4. Core use cases

All of these depend on sections 1 and 3 and on nothing in section 2, so they are
written and tested against in-memory adapters. Each occupies its own boundary,
which is what makes them parallel-safe.

- [ ] 4.1 (P) Provision and list tenants
  - Create an active tenant with a platform-unique name on operator request,
    rejecting missing attributes and duplicate names with the offending attribute
    named
  - Deny tenant creation to any actor that is not an operator
  - List tenants for operators without exposing which people belong to them
  - Done when a duplicate name is rejected with the field identified, a
    non-operator is denied, and no listing response contains membership data
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.3_
  - _Boundary: Tenant provisioning_
  - _Depends: 3.2_

- [ ] 4.2 (P) Deactivate a tenant
  - Mark the tenant inactive while retaining it, its members and their
    memberships
  - Treat deactivating an already inactive tenant as success without change
  - Done when every subsequent request in that tenant is refused regardless of
    the caller's role, and all member records remain queryable by migration-level
    inspection
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - _Boundary: Tenant deactivation_
  - _Depends: 3.2_

- [ ] 4.3 (P) Create a member within a tenant
  - Attach a membership with the requested role, creating the person only if the
    email is not yet known to the platform
  - Perform the same sequence of work in both cases with no early return, so the
    result is identical whether or not the person already existed
  - Reject only when the person already holds an active membership in the actor's
    own tenant, and reject roles outside the permitted set
  - Deny the operation to anyone who is not an administrator of the target tenant
  - Done when creating a member with a brand-new email and with an email already
    registered in a different tenant produce byte-identical responses
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - _Boundary: Member creation_
  - _Depends: 3.2_

- [ ] 4.4 (P) Change a member's role
  - Apply the new role to the membership in the acting tenant only
  - Reject a change that would remove the tenant's last active administrator
  - Done when changing a role leaves the same person's memberships in other
    tenants untouched, and demoting a sole administrator is refused
  - _Requirements: 5.3, 5.4, 7.2_
  - _Boundary: Role change_
  - _Depends: 3.2, 1.4_

- [ ] 4.5 (P) Revoke a membership
  - Mark the membership inactive, leaving the person's memberships elsewhere
    active
  - Reject a revocation that would remove the tenant's last active administrator
  - Deny revocation to an actor who does not administer that tenant
  - Done when a revoked person is refused in that tenant and still served in
    another where their membership remains active
  - _Requirements: 6.1, 6.2, 6.3, 7.1_
  - _Boundary: Membership revocation_
  - _Depends: 3.2, 1.4_

- [ ] 4.6 (P) List members of a tenant
  - Return only people holding a membership in the acting tenant, each with
    whether their membership is active
  - Exclude inactive memberships unless explicitly requested
  - Expose an email address only to administrators of a tenant that person
    belongs to
  - Done when a listing contains no person from another tenant and hides inactive
    members by default
  - _Requirements: 10.1, 10.2, 10.3_
  - _Boundary: Member listing_
  - _Depends: 3.2_

- [ ] 4.7 (P) Deactivate a person platform-wide
  - Mark the person inactive by their platform-wide identifier while retaining
    all their memberships
  - Deny the operation to tenant administrators
  - Done when the deactivated person is refused in every tenant at once and their
    previously created records remain attributable to them
  - _Requirements: 8.1, 8.2, 8.3_
  - _Boundary: Person deactivation_
  - _Depends: 3.2_

## 5. Database adapters

- [ ] 5.1 Implement the tenant-scoped transactional adapter
  - Open a transaction, publish the tenant into transaction-scoped session state,
    and expose the scoped repositories only inside it
  - Connect as the tenant-scoped runtime identity, never as the schema owner
  - Done when tenant context is verifiably absent after the transaction closes,
    so a reused pooled connection carries nothing forward
  - _Requirements: 9.1, 9.2_
  - _Boundary: Persistence adapters_
  - _Depends: 2.4, 3.1_

- [ ] 5.2 Implement the database-backed repositories
  - Write an explicit tenant predicate in every tenant-scoped query, independent
    of the policy that will also apply
  - Implement member listing, active-administrator counting, insertion and status
    and role updates
  - Done when the repository suite passes against a real database with the same
    assertions the in-memory adapters satisfy
  - _Requirements: 4.4, 7.1, 9.1, 10.1, 10.2_
  - _Boundary: Persistence adapters_
  - _Depends: 5.1_

- [ ] 5.3 Implement the operator-scoped adapter
  - Connect as the operator identity and expose only tenant management and
    person deactivation
  - Done when the adapter offers no method capable of reading memberships, and
    the operator identity is rejected by the database if one is attempted
  - _Requirements: 3.1, 3.2, 3.3, 8.1_
  - _Boundary: Persistence adapters_
  - _Depends: 5.1_

## 6. Inbound edge

- [ ] 6.1 Define request and response contracts with validation
  - Validate every incoming payload before it reaches business logic, reporting
    the offending field
  - Reject roles outside the permitted set at the edge, reporting the same
    permitted values the domain reports
  - Done when a malformed payload is rejected without any use case executing
  - _Requirements: 1.2, 4.5_
  - _Boundary: HTTP contracts_
  - _Depends: 4.1_

- [ ] 6.2 Map domain errors to responses uniformly
  - Translate the domain error union in one place
  - Return the same response for refusal and absence, so a caller cannot tell
    whether a record exists in another tenant
  - Preserve the distinction in logs for diagnosis
  - Done when a request naming a record from another tenant is indistinguishable
    from one naming an identifier that exists nowhere
  - _Requirements: 9.2_
  - _Boundary: HTTP error mapping_
  - _Depends: 1.5_

- [ ] 6.3 Expose the tenant, member and person operations
  - Route operator tenant management, administrator member management, and
    operator person deactivation
  - Done when every use case from section 4 is reachable and returns the mapped
    contract
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.3, 6.1, 8.1, 10.1_
  - _Boundary: HTTP controllers_
  - _Depends: 6.1, 6.2_

- [ ] 6.4 Supply the provisional actor context
  - Resolve the acting person, their kind and their tenant at the inbound edge
  - Register it only outside production, since it trusts its input and exists
    solely until authentication arrives
  - Done when the application refuses to register it when running in production
    configuration
  - _Requirements: 9.1_
  - _Boundary: Actor context_
  - _Depends: 6.3_

## 7. Integration

- [ ] 7.1 Compose the feature into the application
  - Bind every contract to its database adapter in one module and import it into
    the application root
  - Keep the same bindings swappable for in-memory adapters under test
  - Done when the application starts with the feature reachable end to end
    against the local environment, and the test suite still runs without a
    database
  - _Depends: 5.2, 5.3, 6.4_
  - _Requirements: 9.1_
  - _Boundary: Composition root_

## 8. Validation

These are the tests the feature exists to make possible. They are not a coverage
formality.

- [ ] 8.1 Prove tenant isolation across the role matrix
  - For each of admin, editor and viewer, assert a member of one tenant is
    refused every read and write against another
  - Assert the refusal is indistinguishable from a record that does not exist
  - Assert a person holding different roles in two tenants receives exactly the
    permissions of the tenant in context, in both directions
  - Done when the matrix passes for every role and both directions, and fails
    loudly if scoping is removed from any single query
  - _Requirements: 5.2, 5.4, 9.1, 9.2, 9.3_
  - _Boundary: Isolation matrix tests_
  - _Depends: 7.1_

- [ ] 8.2 Prove the second isolation layer works independently
  - Issue a query deliberately missing its tenant predicate and assert it still
    returns no foreign rows
  - Done when removing application-level scoping does not produce a cross-tenant
    read, demonstrating the two layers do not share a point of failure
  - _Requirements: 9.1, 9.3_
  - _Boundary: Second-layer tests_
  - _Depends: 7.1_

- [ ] 8.3 (P) Prove the operator boundary
  - Assert an operator can create, list and deactivate tenants
  - Assert an operator receives nothing when reaching for members or memberships,
    and that no operator response reveals tenant participation
  - Done when the operator path is useful for tenant management and inert for
    everything inside a tenant
  - _Requirements: 3.1, 3.2, 3.3_
  - _Boundary: Operator boundary tests_
  - _Depends: 8.1_

- [ ] 8.4 (P) Guard against future tables shipping without policies
  - Assert every tenant-owned table has row-level security enabled and forced
  - Done when adding a tenant-owned table without a policy fails the suite
  - _Requirements: 9.1_
  - _Boundary: Policy coverage tests_
  - _Depends: 8.1_

- [ ] 8.5 (P) Prove the deactivation paths deny access
  - Assert deactivating a tenant refuses every subsequent request in it,
    regardless of role
  - Assert deactivating a person refuses them in every tenant simultaneously
  - Assert both retain their records
  - Done when all four assertions hold and no record was removed
  - _Requirements: 2.1, 2.2, 2.3, 6.2, 8.1, 8.2_
  - _Boundary: Deactivation tests_
  - _Depends: 8.1_

- [ ] 8.6 (P) Prove non-disclosure on member creation
  - Assert the response for an email new to the platform and one already
    registered in a different tenant are identical in status and body
  - Assert a duplicate within the actor's own tenant is rejected, since that
    discloses nothing external
  - Done when the two responses cannot be told apart by content
  - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - _Boundary: Non-disclosure tests_
  - _Depends: 8.1_

## Implementation Notes

- Role parsing returns a result rather than throwing. Throwing would have made
  `role.ts` depend on the domain error union, which in turn depends on `Role` —
  a cycle. The result shape also gives callers the permitted set directly, which
  is what 4.5 asks them to report.
- Task 1.5 was implemented before 1.4 even though the plan lists them the other
  way. The design has the administration policy throw `LastAdministratorError`,
  which lives in the error union; both are `(P)` and neither depends on the
  other, so the order was free.
- The generated ESLint config does not ignore underscore-prefixed unused
  parameters. Write tests that consume their arguments rather than expecting
  `_name` to be tolerated.
- The domain boundary rule was verified live, not assumed: adding a `@nestjs/common`
  import to a domain file was confirmed to fail lint before being reverted.
- Migrations cannot run until the migration role exists, and the Postgres
  container only creates the bootstrap superuser. `pnpm db:bootstrap` creates
  `cubeforge_migrator` idempotently and must run once before `pnpm db:migrate`
  on a fresh database. This prerequisite was missing from the task plan.
- drizzle-kit does not model extensions. `CREATE EXTENSION citext` was added by
  hand at the top of the generated migration; regenerating that migration would
  drop it.
- PostgreSQL `DO $$ ... $$` blocks accept no parameters. Quote identifiers with
  `quote_ident`/`quote_literal` on the server and splice the result instead.
- FORCE ROW LEVEL SECURITY applies to the table owner too, so the migration role
  can no longer read or write these tables. Seed data in the integration harness
  must be inserted as the container superuser, which bypasses RLS unconditionally.
- The design named the membership lookup `findByPersonAndTenant(personId)`, which
  contradicts its own rationale — the tenant comes from the transaction, so there
  is no tenant argument to name. Implemented as `findByPerson`.
- `ActorContext` is a union of `platform-operator` and `tenant-member` rather than
  one shape with an optional tenant, so "an operator acting inside a tenant" is
  unrepresentable and requirement 3.2 needs no runtime check. Operators carry no
  identity: nothing in this feature attributes an action to one.
- `PersonRepository.findOrCreateByEmail` takes `createdAt` so the application
  clock stays authoritative for every entity. The SQL function currently relies
  on the column default, so the Postgres adapter (task 5.x) must add a
  `p_created_at timestamptz` parameter in a new migration.
- Both `insert` methods are specified to throw `DomainViolation` on a uniqueness
  conflict rather than returning a result, because PostgreSQL raises. The
  Postgres adapter must map SQLSTATE 23505 by constraint name to the same two
  errors, or use-case tests will prove a safety production does not have.
- The in-memory unit of work snapshots and restores the store when the work
  throws. Without it a use case could reject a request and still leave rows
  behind, and every test would pass.

- RESOLVED design gap (was blocking 4.3): the `people_app_read` policy hides
  people who belong only to another tenant, but `people.email` is unique
  platform-wide. A tenant admin creating a member whose email existed only
  elsewhere therefore got a duplicate-key error — which both prevented
  requirement 4.2 and leaked the person's existence, violating 4.3. Verified
  empirically. Resolved by `find_or_create_person(uuid, citext)` in migration
  0002: SECURITY DEFINER, pinned `search_path`, returns an id and nothing else,
  executable only by `cubeforge_app`. Recorded in design.md as a boundary
  commitment. Task 4.3 must call it instead of inserting into `people` directly.
- Integration tests run under their own Jest config (`test/jest-integration.json`,
  `pnpm test:integration`) with `maxWorkers: 1`. They share one database and reset
  it by truncating, so parallel workers would delete each other's fixtures. Unit
  tests keep `rootDir: src`, so the two suites cannot pick up each other's files.
- Nothing in this repo loaded `.env` on its own; `pnpm db:bootstrap` only ever
  worked because the environment happened to be sourced. Both it and the
  integration suite now run under `node --env-file-if-exists=.env`. drizzle-kit
  loads `.env` itself, which is why `db:migrate` never showed the problem.
- A SECURITY DEFINER function does not escape FORCE RLS — it runs as the owner,
  and the owner is subject to policies. The `ON CONFLICT DO UPDATE` branch needs
  an owner UPDATE policy, not just SELECT and INSERT; without it the conflict
  path fails and precisely the case the function exists for stays broken.
