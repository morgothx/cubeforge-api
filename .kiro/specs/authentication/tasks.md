# Implementation Tasks — authentication

Ordering follows Foundation → Core → Integration → Validation. Task N implicitly
depends on everything before it; `_Depends:_` marks only non-obvious or
cross-group dependencies. `(P)` marks tasks safe to run concurrently with their
immediate peers.

## 1. Cryptographic foundation

The two adopted libraries carry the only irreversible risk in this feature, so
they are proven before anything is built on them.

- [x] 1.1 Prove the token library under this build
  - Add the token library and sign and verify a token from compiled output, not
    only from the test runner
  - Confirm the module format works from a CommonJS build and under the test
    runner, since the library ships ECMAScript modules only
  - Read the signing secret from configuration, validated at startup like every
    other setting
  - Done when a signed token round-trips in a unit test and in the built
    application, and startup fails with a clear message when the secret is absent
  - _Requirements: 3.1, 3.2, 3.5_
  - _Boundary: Token adapter_

- [x] 1.2 (P) Prove the password hasher under this package manager
  - Add the hashing library and confirm it installs with lifecycle scripts still
    denied, so no reviewed build-script exception is needed
  - Hash and verify a password, with cost parameters read from configuration
  - Measure one hash on this machine and record the figure, so the parameters are
    chosen rather than inherited
  - Done when a wrong password fails verification, a correct one passes, and
    `pnpm install` succeeds without granting a build script
  - _Requirements: 1.2, 1.7, 2.1_
  - _Boundary: Password adapter_

- [x] 1.3 (P) Generate and digest opaque secrets
  - Produce secrets with at least 128 bits of entropy from the platform's
    cryptographic source
  - Digest them with a fast hash rather than a password hash, because random
    secrets have nothing to brute-force
  - Keep raw secrets and digests distinguishable at the type level, so a raw
    value cannot reach a column expecting a digest
  - Done when passing a raw secret where a digest is expected fails to compile
  - _Requirements: 1.1, 4.1, 7.1_
  - _Boundary: Secret adapter_

- [x] 1.4 (P) Express the password rule in the domain
  - Accept passwords of at least the required length and impose no composition
    rules
  - Report rejection as a validation failure naming the offending field
  - Done when a short password is rejected and a long passphrase without digits
    or symbols is accepted
  - _Requirements: 1.4_
  - _Boundary: Password policy_

- [x] 1.5 (P) Express the session rules in the domain
  - Decide, from a refresh token's recorded state and the current time, whether
    it may be exchanged, is expired, or has already been used
  - Treat re-use of an exchanged token as a signal that the whole family must end
  - Compute the absolute session deadline from the sign-in, not from the last
    issuance
  - Done when each of valid, expired, already-exchanged and invalidated produces
    a distinct decision, and re-use reports that the family must be invalidated
  - _Requirements: 4.1, 4.2, 4.3_
  - _Boundary: Session rules_

## 2. Persistence foundation

- [x] 2.1 Create the credential tables and their policies
  - Add tables for credentials, setup tokens, refresh tokens, API keys and
    operator status, storing digests and never secrets
  - Enable and force row-level security on every one of them
  - Give the API key table two policies for its two audiences: unscoped
    resolution, and tenant-scoped management
  - Done when the migration applies to an empty database and the existing
    policy-coverage tests still pass with the new tables present
  - _Requirements: 7.1, 7.5, 7.6, 11.1_
  - _Boundary: Schema_

- [x] 2.2 Add the authenticating database identity
  - Create a fourth runtime identity with grants on the credential tables and no
    tenant context
  - Grant the tenant-scoped identity nothing at all on credentials, refresh
    tokens or operator status
  - Extend connection configuration and the bootstrap script to cover it
  - Done when a query for a password digest as the tenant-scoped identity is
    refused by the database as a permission error, not as an empty result
  - _Requirements: 10.1_
  - _Boundary: Database roles_
  - _Depends: 2.1_

- [x] 2.3 Provide the operator bootstrap act
  - Offer a script that records an existing person as a platform operator,
    outside the API entirely
  - Refuse to run against an unknown person, so a typo cannot create a dangling
    operator record
  - Done when running it makes a person an operator, running it twice changes
    nothing, and no route exists that could have done the same
  - _Requirements: 11.1, 11.5_
  - _Boundary: Operator bootstrap_
  - _Depends: 2.1_

- [x] 2.4 Extend the integration harness for authentication
  - Let a test act as the authenticating identity, and reset the new tables
    between tests
  - Provide a way to arrange a person with a usable credential without going
    through the operator flow, so tests of other behaviour stay short
  - Done when a test can sign a person in and assert against the resulting
    session repeatably, with no leakage between tests
  - _Requirements: 10.1_
  - _Boundary: Test infrastructure_
  - _Depends: 2.2_

## 3. Contracts and test doubles

- [x] 3.1 Widen the acting principal
  - Give the operator an identity, so operator actions are attributable
  - Add a machine kind carrying its tenant and role
  - Update every existing construction of an actor, in code and in tests, to the
    new shape
  - Done when the full existing suite passes unchanged in behaviour, and a
    machine actor reaching a tenant-member route is answered as an absence
  - _Requirements: 7.3, 11.2, 11.6_
  - _Boundary: Actor context_

- [x] 3.2 Declare the authentication contracts
  - Declare contracts for hashing, token issuing, secret generation, and for the
    credential, session and API key stores
  - Declare the authenticating transaction as the only route to the credential
    stores, mirroring how tenant scoping is already reached
  - Keep every failure of token verification indistinguishable at the contract
    level, so no caller can branch on why a token was rejected
  - Done when no credential store can be obtained outside an authenticating
    transaction
  - _Requirements: 3.3, 3.4, 10.1_
  - _Boundary: Ports_
  - _Depends: 3.1_

- [x] 3.3 Implement in-memory adapters for the contracts
  - Satisfy every contract from 3.2 with in-memory storage, including single-use
    and expiry semantics
  - Make hashing and token issuing deterministic under test without weakening the
    real implementations
  - Done when the full use-case suite can run with no database available
  - _Requirements: 10.1_
  - _Boundary: In-memory adapters_
  - _Depends: 3.2_

## 4. Core use cases

All of these run against the in-memory adapters. Each occupies its own boundary,
which is what makes them parallel-safe.

- [x] 4.1 (P) Establish a credential
  - Let a platform operator issue a single-use setup token for a person, returned
    once and stored only as a digest
  - Let the holder redeem it with a new password, invalidating the token and
    ending every session that person holds
  - Reject a redeemed, expired or invented token with one indistinguishable
    response
  - Deny issuance to anyone who is not a platform operator
  - Done when redeeming the same token twice fails the second time with the same
    response as an invented one, and an established credential ends prior sessions
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7_
  - _Boundary: Credential establishment_
  - _Depends: 3.3, 1.4_

- [x] 4.2 (P) Sign in
  - Issue an access token and a refresh token for a correct address and password
  - Reject an unknown address, an address without a credential, and a wrong
    password with one identical response
  - Perform the same verification work on all three paths, so an unknown address
    is not measurably faster than a wrong password
  - Refuse a deactivated person, with that same response
  - Issue tokens to a person who holds no membership anywhere
  - Done when the three rejection causes are byte-identical in the response, and
    the unknown-address path still performs a verification
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 6.1, 9.4_
  - _Boundary: Sign-in_
  - _Depends: 3.3_

- [x] 4.3 (P) Refresh and end sessions
  - Exchange a valid refresh token for a new pair and retire the presented one
  - Invalidate every token descended from the same sign-in when an already
    exchanged one is presented
  - Reject expired, invalidated and unrecognized tokens with one response
  - End one session on sign-out and every session on sign-out everywhere
  - Refuse to refresh for a deactivated person, and end their sessions
  - Done when re-using an exchanged token leaves the whole family unusable, and
    signing out everywhere leaves no refresh token accepted
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 6.1, 6.2_
  - _Boundary: Session lifecycle_
  - _Depends: 3.3, 1.5_

- [x] 4.4 (P) Manage API keys
  - Let a tenant administrator issue a key with a label and a permitted role,
    returning its secret exactly once
  - List a tenant's keys with label, role, creation time and last use, and never
    the secret
  - Revoke a key so no later request presenting it is accepted
  - Deny issuing, listing and revoking to anyone who is not an administrator of
    that tenant
  - Keep a key working after the administrator who created it loses their
    membership
  - Done when a listing contains no secret, a revoked key is refused, and a key
    outlives its issuer's membership
  - _Requirements: 7.1, 7.2, 7.5, 7.6, 7.7, 7.9_
  - _Boundary: API key management_
  - _Depends: 3.3_

- [x] 4.5 (P) Provision a tenant with its first administrator
  - Accept an administrator's address alongside the tenant name, and grant that
    person an active administrator membership
  - Create nothing at all when the tenant name is already in use
  - Return a response identical whether or not the address was already known to
    the platform
  - Establish no credential as part of provisioning
  - Done when a rejected provisioning leaves neither tenant nor membership, and
    the two address cases are indistinguishable in the response
  - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - _Boundary: Tenant provisioning_
  - _Depends: 3.3_

## 5. Database adapters

- [ ] 5.1 Implement the authenticating transactional adapter and its stores
  - Open transactions as the authenticating identity, publishing no tenant
  - Implement the credential, setup token and refresh token stores against it
  - Done when the same use-case assertions pass against a real database as
    against the in-memory adapters
  - _Requirements: 1.1, 1.2, 2.1, 4.1, 4.2, 10.1_
  - _Boundary: Persistence adapters_
  - _Depends: 2.2, 3.2_

- [ ] 5.2 Implement the API key store for both audiences
  - Resolve a key without any tenant context, for authentication
  - Manage a tenant's keys under the tenant predicate, for administrators
  - Record the time a key was last used successfully
  - Refuse keys belonging to an inactive tenant
  - Done when resolution works with no tenant published, management returns only
    the acting tenant's keys, and last use advances after a successful request
  - _Requirements: 6.3, 7.3, 7.4, 7.8_
  - _Boundary: Persistence adapters_
  - _Depends: 5.1_

- [ ] 5.3 Implement the operator status store
  - Read whether a person is recorded as an operator, with no way to write it
    through the application
  - Done when withdrawing operator status outside the API takes effect on the
    next request without any token changing
  - _Requirements: 11.1, 11.3, 11.4_
  - _Boundary: Persistence adapters_
  - _Depends: 5.1_

## 6. Inbound edge

- [ ] 6.1 Resolve a principal from a presented credential
  - Turn a bearer token into a person, and an API key into a machine principal
    carrying its tenant and role
  - Take the tenant of a person's request from the path, never from the token
  - Establish an operator principal only for a person recorded as one
  - Treat absent, malformed, expired and unverifiable credentials alike, as no
    principal at all
  - Done when the four failure modes are indistinguishable to the caller, and a
    token naming a tenant has no effect on which tenant is used
  - _Requirements: 3.3, 3.4, 7.3, 10.1, 11.2, 11.3_
  - _Boundary: Principal resolution_
  - _Depends: 5.2, 5.3_

- [ ] 6.2 Replace the provisional actor middleware
  - Attach the resolved principal to every request
  - Delete the header-reading middleware rather than disabling it, so no
    configuration can bring it back
  - Answer a request carrying no credential as though the referenced record does
    not exist
  - Done when the header-based requests that worked before are now refused, and
    no code path can assert its own principal
  - _Requirements: 10.1, 10.2, 10.3_
  - _Boundary: Inbound principal_
  - _Depends: 6.1_

- [ ] 6.3 Expose the authentication and credential operations
  - Route signing in, refreshing, signing out, issuing a setup token and
    redeeming one
  - Validate every payload before it reaches business logic
  - Return a session without ever returning a stored secret
  - Done when every use case from section 4 is reachable and a malformed payload
    is rejected without any use case executing
  - _Requirements: 1.1, 1.2, 2.1, 4.1, 5.1, 5.2_
  - _Boundary: Authentication routes_
  - _Depends: 6.2_

- [ ] 6.4 Expose tenant API key management
  - Route issuing, listing and revoking within a tenant
  - Reconcile the tenant in the path with the acting principal's, as the member
    routes already do
  - Done when a key secret appears exactly once, in the issuing response, and
    never in a listing
  - _Requirements: 7.1, 7.2, 7.5, 7.6, 7.7_
  - _Boundary: API key routes_
  - _Depends: 6.2_

- [ ] 6.5 Throttle the credential endpoints and record outcomes
  - Add the throttling library, noting that its default storage is per process
    and would need a shared store once more than one instance serves requests
  - Limit sign-in attempts per address and per origin, and setup-token
    redemptions per origin, rejecting further attempts for a cooling period
  - Never disable an account as a consequence of failed attempts
  - Record the cause of each authentication failure and the request's correlation
    identifier, while the response discloses neither
  - Keep passwords, tokens and key secrets out of every log entry
  - Done when exceeding the limit is refused with a distinguishable response
    while the underlying failure remains indistinguishable, and no log line
    contains a secret
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 12.1, 12.2_
  - _Boundary: Throttling and logging_
  - _Depends: 6.3_

- [x] 6.6 Extend the tenant provisioning route
  - Accept an administrator's address alongside the tenant name, and validate it
    as an address before any use case runs
  - Return the same response shape whether or not that person was already known
    to the platform
  - Done when provisioning through the route yields a tenant whose administrator
    can immediately act in it, with no direct database write anywhere
  - _Requirements: 8.1, 8.3_
  - _Boundary: Tenant routes_
  - _Depends: 4.5, 6.2_

## 7. Integration

- [ ] 7.1 Compose authentication into the application
  - Bind every contract to its adapter in one module and import it into the root
  - Keep the same bindings swappable for in-memory adapters under test
  - Update the existing integration and end-to-end suites to arrange principals
    through credentials rather than headers or raw membership inserts
  - Done when the application starts with authentication reachable end to end
    against the local environment, and the whole suite runs without a database
    where it did before
  - _Requirements: 10.1, 10.2_
  - _Boundary: Composition root_
  - _Depends: 6.5, 6.6, 5.3_

## 8. Validation

These are the tests that make the feature defensible rather than merely working.

- [ ] 8.1 Prove that credentials are unreachable from the tenant-scoped identity
  - Assert the tenant-scoped identity is refused on credentials, refresh tokens
    and operator status as a permission error rather than an empty result
  - Assert an administrator listing their members cannot obtain any digest
  - Done when the assertions fail if any grant is widened
  - _Requirements: 1.7, 10.1_
  - _Boundary: Credential isolation tests_
  - _Depends: 7.1_

- [ ] 8.2 (P) Prove authentication discloses nothing
  - Assert an unknown address, an address without a credential and a wrong
    password produce identical responses
  - Assert the same for a redeemed, expired and invented setup token
  - Assert a throttled response is identical whether or not the address exists
  - Done when every pair is identical in status and body, and the assertions fail
    if any branch reports its cause
  - _Requirements: 1.3, 2.2, 2.3, 9.4_
  - _Boundary: Non-disclosure tests_
  - _Depends: 7.1_

- [ ] 8.3 (P) Prove session revocation behaves as specified
  - Assert re-using an exchanged refresh token ends the whole family
  - Assert signing out everywhere leaves no refresh token accepted
  - Assert an already-issued access token remains usable until it expires, which
    is the stated cost of the design rather than a defect
  - Done when all three hold, and the family assertion fails if invalidation is
    narrowed to the presented token
  - _Requirements: 4.2, 5.1, 5.2, 5.3_
  - _Boundary: Session revocation tests_
  - _Depends: 7.1_

- [ ] 8.4 (P) Prove API keys are confined to their tenant
  - Assert a key presented against another tenant's route is answered as an
    absence
  - Assert a revoked key is refused, and a key of an inactive tenant is refused
  - Assert an administrator sees only their own tenant's keys
  - Done when the confinement assertions fail if the tenant check is removed
  - _Requirements: 6.3, 7.4, 7.6_
  - _Boundary: API key isolation tests_
  - _Depends: 7.1_

- [ ] 8.5 (P) Prove the operator boundary depends on recorded status
  - Assert a person not recorded as an operator cannot act as one, whatever the
    request contains
  - Assert withdrawing operator status takes effect on the next request without
    the token changing
  - Assert operator actions are attributable to a person
  - Done when the assertions fail if operator status is read from the request
    rather than from storage
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6_
  - _Boundary: Operator boundary tests_
  - _Depends: 7.1_

- [ ] 8.6 Prove the bootstrap gap is closed and the bypass is gone
  - Walk the whole path with no direct database writes: provision a tenant with
    its administrator, issue a setup token, redeem it, sign in, add a member,
    refresh, sign out
  - Assert the requests that previously asserted their own principal through
    headers are now refused
  - Done when the walk succeeds without raw SQL, and no header can influence who
    the caller is
  - _Requirements: 8.1, 10.2, 10.3, 11.5_
  - _Boundary: Bootstrap and bypass tests_
  - _Depends: 7.1_

## Implementation Notes

Findings recorded during implementation belong here, so the next feature inherits
them rather than rediscovering them.

- **`jose` was adopted in the design and rejected in task 1.1.** `require('jose')`
  works on Node 22.23, which is what the design verified, but Jest's own module
  runtime does not support `require(esm)` and fails with `Unexpected token
  'export'`. `transformIgnorePatterns` cannot exempt it cleanly under pnpm: the
  real path is `node_modules/.pnpm/jose@6.2.8/node_modules/jose/...`, so any
  pattern that spares the outer `node_modules` still matches the inner one. The
  remaining routes were Jest in ESM mode (`--experimental-vm-modules`, and a
  migration of 113 CommonJS tests) or transforming all of `node_modules`.
  Replaced with `@nestjs/jwt`, the fallback the design already named. The cost is
  ten transitive dependencies, seven of them `lodash.*` micro-packages — recorded
  because it runs against the project's supply-chain stance and should be
  revisited if the test runner ever moves to ESM.
- **Verify a dependency under the test runner, not only under Node.** The design's
  check ran `require()` in a plain Node process and concluded the package was
  usable. It was not. Any future ESM-only dependency needs the same two-place
  check that task 1.1 now performs: the runner and the compiled output.
- **4.5 completed 6.6 as a side effect**, because changing the use case's command
  breaks the controller that calls it. Both are marked done; the route validates
  the administrator's address at the edge and the use case parses it again.
- Provisioning writes the tenant on the operator connection and the person and
  membership on the tenant-scoped one — two connections, therefore two
  transactions, therefore not atomic. The tenant goes first so a duplicate name
  fails before anything else runs (requirement 8.2). If the second step fails the
  tenant is **deactivated** as a compensating action: leaving a tenant nobody can
  administer would recreate the very gap this task closes.
- The integration harness no longer inserts a first membership with raw SQL —
  provisioning creates it. The administrator's identifier is read back through a
  privileged connection because the response deliberately does not disclose it.
  That is a piece of task 7.1 landing early, and a good sign: the bootstrap gap
  is closed where the tests used to work around it.
- As predicted, 4.4 pulled a slice of 5.2 with it: `apiKeys` had to join
  `TenantScopedRepositories`, obliging `PostgresTenantScopedUnitOfWork` to supply
  it. `PostgresApiKeyRepository` (the administrator's half) exists now; the
  authenticator's half — resolution, last-use, inactive tenants — is still 5.2.
- Revoking looks the key up first rather than issuing a blind update. The
  repository ignores rows outside the tenant, so a blind revoke would succeed
  silently and tell the caller nothing about whether anything happened.
- Revoking twice keeps the first moment: the update matches only unrevoked rows.
- **A refusal that has work to do cannot throw inside the transaction.** Refresh
  invalidates a family when a token is replayed, then rejects — and throwing
  rolled the invalidation back with everything else. Found by a test asserting
  the successor token also died; it did not. The transaction now reports its
  verdict and the rejection is raised after it commits. Any later use case whose
  rejection writes something must do the same.
- Refreshing does not extend the session: the successor inherits the family's
  deadline. Otherwise a session used daily would never end.
- Signing out with an unrecognized token succeeds silently. Refusing would tell
  someone holding a guessed value that it never existed, and there is nothing to
  protect in an operation whose only effect is removing access.
- Sign-in has **one** branch and it chooses which digest to compare, not whether
  to compare. Unknown address, no credential and deactivated all verify against a
  decoy at full cost; returning early on any of them would make those paths
  measurably faster than a wrong password. The decoy is computed once per hasher.
- A malformed email is rejected exactly like an unknown one. Reporting it as
  invalid would be a small, reliable oracle: it tells the caller their guess was
  never going to match.
- The non-disclosure test collects the outcomes of all five failure paths and
  asserts the set has one member, rather than checking each against a literal.
- Task 4.1 forced the deferred wiring: `setupTokens` had to join
  `PlatformRepositories`, which obliges the Postgres adapter to supply it, so a
  slice of task 5.1 landed here. A repository bundle cannot be half-populated;
  the alternative was giving the use case a construction path that skips the
  unit of work, which is the thing the design forbids.
- The password rule is checked *before* the token is looked up, so a mistyped
  password does not burn the holder's single-use token. Ordering, not an extra
  branch.
- The identifier port grew `apiKeyId`, `signInId` and `rowId`. `rowId` is
  deliberately unbranded: setup tokens and refresh tokens need an identity in
  the database and nowhere else, so a brand would add a type no reader benefits
  from. Caught while writing the use case, where a `membershipId` was standing
  in for a setup token id.
- **Issuing a setup token and redeeming one are different contracts on different
  connections**, which the design did not separate. The operator may create a
  token and never read one back; the authenticator may read and retire one and
  never create one. The grants in migration 0006 already said this — the ports
  now say it too.
- `ApiKeyRepository` and `SetupTokenIssuingRepository` are declared but not yet
  members of the tenant-scoped and platform repository bundles. Adding a field to
  a bundle obliges every adapter to supply it, and the Postgres ones belong to
  tasks 5.2 and 5.1; wiring them in early would have meant writing those adapters
  under a task that says "contracts". They join the bundles when their adapters
  exist.
- `PasswordHasher` carries `verifyAgainstDecoy`, which the design did not name.
  Requirement 2.2 needs an unknown address to cost the same as a wrong password,
  and leaving that to each caller to remember is how a timing channel reappears.
- Widening `ActorContext` broke three specs that each declared their own
  operator headers instead of importing the shared constant. Worth knowing before
  task 7.1 replaces those headers with credentials: the duplication is in
  `http-edge.spec.ts` and `application.integration-spec.ts`.
- The machine kind needed no handling anywhere: `tenantOf` already refuses any
  actor that is not a tenant member, so a machine principal reaching an identity
  route is answered as an absence. A test asserts it rather than leaving it to
  be rediscovered.
- `pnpm ops:grant-operator <email> [--withdraw]` runs as the **migration**
  identity, not a superuser, so the act is available wherever migrations run
  rather than only on a developer's machine. Migration 0007 adds the owner
  policies it needs — owning the table is not enough under `FORCE ROW LEVEL
  SECURITY`, which is the same lesson 0002 records for `people`.
- The harness truncates the credential tables by name rather than relying on
  `CASCADE` from `people`, so a table added without being listed here leaks a row
  into the next test immediately instead of silently much later.
- The authenticating role is created `NOLOGIN` in the same migration as the
  policies that reference it, because a policy cannot name a role that does not
  exist yet. `pnpm db:bootstrap` grants it LOGIN with a password from the
  environment, exactly as the other runtime roles are handled.
- `platform_operators` has no `revoked_at`: withdrawing the status deletes the
  row. Unlike a membership it attributes no historical data, so there is nothing
  to retain.
- Verified after migrating: no table in `public` lacks forced row-level security
  or a policy, and `cubeforge_app` is refused on all four credential tables with
  a permission error rather than an empty result — which is what task 8.1 will
  assert rather than assume.
- **`@node-rs/argon2` installs with no build script**, as the design predicted:
  `pnpm install` reports nothing ignored, so no reviewed exception was needed.
  Its `Algorithm` enum is an ambient `const enum`, which `isolatedModules`
  forbids reading — the unit tests passed while `pnpm build` failed, because
  ts-jest transpiles without type-checking. The algorithm is named as a typed
  literal instead of relying on the library's default.
- **Measured on this machine** (hash / verify): 19456 KiB with t=2 → 46 ms / 57 ms;
  47104 KiB with t=1 → 92 ms / 59 ms; 65536 KiB with t=3 → 269 ms / 260 ms. The
  OWASP baseline is the default and is comfortably fast here; the parameters are
  configuration so a slower host can lower them without a code change.
- Opaque secrets are digested with SHA-256, not with a password hash. They carry
  256 random bits, so there is nothing to guess, and a slow digest would only
  make every authenticated request slower for no protection.
- Password length is counted in characters rather than UTF-16 code units, so a
  passphrase of emoji is not silently worth double.
- Re-use of a refresh token is detected *before* expiry is considered. A replayed
  token is evidence that someone else may hold a copy, and that is worth acting
  on even when the token would have been refused anyway.
- Access token expiry is checked against an injected instant rather than the
  library's own clock reading (`ignoreExpiration` plus an explicit comparison),
  so tests can place themselves in time and the application keeps one notion of
  now. The signing algorithm is pinned in the verifier and never read from the
  token header.
