# Implementation Tasks — rbac-authorization-guards

Ordering follows Foundation → Core → Integration → Validation. Task N implicitly
depends on everything before it; `_Depends:_` marks only non-obvious or
cross-group dependencies. `(P)` marks tasks safe to run concurrently with their
immediate peers.

## 1. The declaration and the inventory that reads it

Both are prerequisites for everything else: the guard enforces the first, and
every validation task in section 5 walks the second.

- [x] 1.1 Express what a route may declare
  - Support the four shapes the requirements name: reachable with no principal,
    reachable only by a platform operator, reachable by named tenant roles, and
    whether a machine credential is admitted alongside those roles
  - Reject the combinations that cannot mean anything — public together with
    roles, operator together with machines, and a declaration that permits
    nobody — at compile time where the type can carry it and at construction
    otherwise
  - Keep it to one metadata key, so "this route declares nothing" is the absence
    of one thing rather than a combination that has to be interpreted
  - Done when a declaration can be attached to a route and read back from it,
    and each illegal combination fails a test that names which one it is
  - _Requirements: 1.1, 1.5, 1.6, 3.1_
  - _Boundary: Access declaration_

- [x] 1.2 Enumerate every route and what it declares
  - Walk the assembled application's controllers and handlers, reporting each
    one's HTTP method, path, and its declaration or the absence of one
  - Take the list from the framework rather than from a hand-maintained
    register, so a route nobody remembered still appears
  - Done when it reports all sixteen existing routes from the real application,
    and a route added in a test fixture appears without the inventory being told
    about it
  - _Requirements: 6.2_
  - _Boundary: Route inventory_

## 2. The guard

One component, built in four passes. These are deliberately **not** `(P)`: they
all edit the same decision path, and splitting them across agents would produce
four conflicting versions of one file.

- [x] 2.1 Refuse a route that declares nothing, and admit the ones that declare
      themselves public
  - Refuse before the handler runs, and prove it with a handler that records
    whether it was entered
  - Treat an absent declaration as a refusal for every caller, including one who
    would satisfy any declaration the route might plausibly have carried
  - Answer a caller with no principal on a non-public route exactly as a caller
    whose record does not exist
  - Build it against the in-memory adapters and construct it directly in these
    tests; it is not registered anywhere until 4.5, so nothing here needs the
    module wiring to exist yet
  - Done when an undeclared route refuses an operator, an administrator and an
    anonymous caller alike, and the handler behind it never ran
  - _Requirements: 1.2, 1.4, 1.5, 5.5_
  - _Boundary: Access guard_

- [x] 2.2 Enforce the operator declaration
  - Admit a platform operator; refuse everyone else as an absence
  - Refuse an operator on a route that declares tenant roles, and refuse a
    tenant member on a route that declares an operator
  - Done when the two kinds of principal are refused in both directions, and
    withdrawing operator status refuses the next request with the same token
  - _Requirements: 1.6, 6.3, 6.4_
  - _Boundary: Access guard_

- [x] 2.3 Enforce tenant roles by resolving the membership
  - Resolve the tenant, the person and their membership in a transaction of the
    guard's own, scoped to the tenant the request path names, and apply the
    existing access decision rather than restating it
  - Distinguish the two refusals the way the application layer already does: an
    absence when the caller has no standing in this tenant, a denial only when
    they are a member whose role is not permitted — and let both reach the
    caller as the same response
  - Attach the reason to every refusal so it reaches the log and no response
  - Decide by the role held in the tenant the path names, so a person with
    different roles in two tenants is judged separately in each
  - Done when a viewer is refused an administrator's route with a denial, a
    stranger is refused the same route with an absence, the two responses are
    byte-identical, and the log tells them apart
  - _Requirements: 1.1, 2.4, 4.3, 5.1, 5.2, 5.3, 5.4_
  - _Boundary: Access guard_

- [ ] 2.4 Refuse machine callers unless a route admits them
  - Refuse a machine credential on any route that does not declare machines
    admissible, whatever role that credential carries
  - Where a route does admit them, permit a credential carrying a permitted role
    only when the credential's tenant is the tenant the path names
  - Cover this with a fixture route rather than by opening a real endpoint: no
    existing route admits machines, and inventing one would be feature 5's
    decision made early
  - Done when a key carrying `admin` is refused an administrator route, the
    fixture route admits it, and the same key is refused on the fixture route
    when the path names another tenant
  - _Requirements: 3.2, 3.3, 3.4_
  - _Boundary: Access guard_

- [ ] 2.5 Measure what the guard's resolution costs
  - Time a tenant-scoped request with the guard resolving and with it short-
    circuited, on this machine, against the local database
  - Record the figure in the Implementation Notes, so the transaction decision
    is one that was measured rather than assumed
  - Done when the note states both figures and the difference, and says whether
    it changes the design's answer
  - _Requirements: 4.3_
  - _Boundary: Access guard_

## 3. What the use cases enforce, said out loud

- [ ] 3.1 Name the roles each tenant-scoped use case enforces, and widen the
      listing
  - Replace the role literal inside each of the seven tenant-scoped
    authorization calls with a named value the use case exports
  - Widen listing a tenant's members to administrator, editor and viewer; leave
    every mutation and every API key operation with the administrator
  - **Do not share these values with the route declarations.** The two layers
    are meant to fail independently, and one constant read by both would be a
    single point of failure wearing two hats. Task 5.2 is what keeps them
    honest, not a shared import
  - Done when the seven values are exported and used, the listing use case
    admits all three roles, and the existing use-case suites still pass with the
    widened rule asserted
  - _Requirements: 2.1, 4.2_
  - _Boundary: Application use cases_

## 4. Declare the routes, then turn the guard on

Declaration comes first on purpose. Registering the guard while routes are still
undeclared would refuse them — correctly, and catastrophically for the suite —
so 4.5 is last and is the task that makes the feature live.

- [ ] 4.1 (P) Declare the authentication routes reachable without a principal
  - All four credential endpoints, each stating it explicitly rather than
    inheriting anything
  - Done when signing in still works with no credential presented
  - _Requirements: 1.5_
  - _Boundary: Authentication controller_

- [ ] 4.2 (P) Declare the operator routes
  - Provisioning, listing and deactivating a tenant; deactivating a person;
    issuing a setup token
  - Done when all five carry an operator declaration and the inventory reports
    no undeclared route among them
  - _Requirements: 1.6_
  - _Boundary: Tenants, platform people and credential setup controllers_

- [ ] 4.3 (P) Declare the tenant member routes
  - Listing declares all three roles; creating, re-roling and revoking declare
    the administrator
  - Done when a viewer can list the tenant's members through the route and is
    refused all three mutations
  - _Depends: 3.1_
  - _Requirements: 2.1, 2.2_
  - _Boundary: Tenant members controller_

- [ ] 4.4 (P) Declare the API key routes
  - All three declare the administrator, reading included
  - Done when an editor and a viewer are both refused the listing
  - _Requirements: 2.3_
  - _Boundary: API keys controller_

- [ ] 4.5 Register the guard for every route
  - Bind it globally, so a route that was never considered is still covered
  - Give it the dependencies it needs to resolve a membership, without making
    any use case aware of it
  - Done when the full existing suite passes with the guard live, and changing
    one route's declaration changes what that route admits with no change to the
    use case behind it
  - _Depends: 2.4, 4.1, 4.2, 4.3, 4.4_
  - _Requirements: 1.2, 1.3, 1.4_
  - _Boundary: Authorization module_

## 5. Validation

- [ ] 5.1 Prove no route is undeclared, and no declaration is meaningless
  - Assert every route in the assembled application carries a declaration, and
    name the offenders when one does not
  - Assert no declaration is self-contradictory or permits nobody, and that no
    shipped route admits machines
  - Done when removing one route's declaration fails this test with that route
    named, and the failure is legible enough to act on without opening the file
  - _Requirements: 1.2, 3.4, 6.2_
  - _Boundary: Route inventory tests_

- [ ] 5.2 Prove the declared roles and the enforced roles have not drifted
  - Compare each route's declared roles against the value the use case behind it
    enforces; for operator routes, compare the declaration against the use case
    requiring an operator
  - Done when widening a declaration without widening its use case fails this
    test, and widening the use case without the declaration fails it too
  - Not `(P)`: it shares the inventory suite with 5.1
  - _Depends: 3.1_
  - _Requirements: 4.2_
  - _Boundary: Route inventory tests_

- [ ] 5.3 Prove the matrix: every role, every route, refused in every direction
  - Walk every route in the application for each of the three roles, in their
    own tenant and against another, through the assembled application and the
    real database
  - Include the two principals that are not tenant members: an operator against
    tenant routes and a member against operator routes
  - Include a person holding different roles in two tenants, decided separately
    in each
  - Include a tenant deactivated and a person deactivated mid-session
  - Done when the matrix covers every route the inventory reports, so a route
    added later cannot quietly escape it, and unregistering the guard fails it
  - _Depends: 4.5_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 5.4, 6.1, 6.3, 6.4_
  - _Boundary: Role matrix tests_

- [ ] 5.4 (P) Prove a refusal still discloses nothing
  - Assert a refusal for the wrong role and a refusal for no membership at all
    are identical in status and body
  - Assert the reason for each appears in the log and in no response
  - Done when the pair is byte-identical and the assertions fail if either
    refusal starts reporting its cause
  - _Depends: 4.5_
  - _Requirements: 5.1, 5.2, 5.3, 5.5_
  - _Boundary: Disclosure tests_

- [ ] 5.5 (P) Prove the second layer stands on its own
  - Invoke a tenant-scoped use case directly, with no route and no guard, and
    assert it still refuses an actor whose role is not permitted
  - Done when deleting the guard's registration leaves this test passing while
    the matrix fails, which is what "two layers" has to mean
  - _Depends: 4.5_
  - _Requirements: 4.1, 4.3_
  - _Boundary: Application use case tests_

- [ ] 5.6 Settle the overlap with the existing isolation matrix
  - The isolation suite from feature 1 and the matrix from 5.3 assert
    overlapping claims; decide which owns which, and leave one home for each
  - Do not delete coverage to resolve a duplicate — move it
  - Done when both suites pass, neither asserts the same claim as the other, and
    a note records what moved and why
  - _Depends: 5.3_
  - _Requirements: 6.1_
  - _Boundary: Integration suites_

## Implementation Notes

Findings recorded during implementation belong here, so the next feature
inherits them rather than rediscovering them.

- **`PATH_METADATA` and `METHOD_METADATA` are not re-exported from
  `@nestjs/common`.** They live in `@nestjs/common/constants`. Importing them
  from the package root type-checks and builds cleanly, then hands `undefined`
  to `Reflector.get` at runtime — the failure reads `Cannot read properties of
  undefined (reading 'KEY')` and points at the reflector, not at the import.
- **A union type does not reject every contradictory declaration.**
  TypeScript's excess-property check against a union permits any property that
  appears in *some* member, so `{ public: true, roles: [...] }` compiles. Found
  by type-checking a scratch file of illegal declarations rather than by
  assuming; the design said the type carried all three and it carries two. The
  runtime assertion covers every shape as a result.
- The declaration decorates classes as well as methods, which the design's
  `MethodDecorator` signature would have forbidden while its guard section
  required it. `SetMetadata` returns both; the design has been corrected.
- The inventory is asserted against the real application by listing the sixteen
  routes by name rather than counting them, so adding one fails with the route
  named instead of with a number nobody can act on. It is built by hand from
  `ModulesContainer` in that test because nothing provides it until 4.5.
- **The guard fails closed on declarations it cannot yet judge.** Built in
  passes, so between 2.1 and 2.3 it refuses `operator` and `roles` routes
  outright rather than admitting what it has not learned to evaluate. A
  half-built guard that let those through would be worse than none, because it
  would look like one. Each later pass replaces a refusal with a decision.
- 2.1 touched one file outside its boundary: `principal.middleware.ts` gained an
  exported `attachActor`, which is the write the middleware already performed
  inline. Exported so the `ACTOR` symbol stays private and a test that needs a
  principal without a credential has to say so by calling it, instead of
  reaching into the request. Worth the spill; recorded rather than hidden.
- The guard takes only the `Reflector` so far. The design's constructor also
  names the tenant-scoped unit of work, which arrives in 2.3 where it is first
  used — a dependency injected before it is needed is a dependency nobody can
  see the reason for.
- Proved by breaking, not by watching: admitting undeclared routes fails five
  tests, and the one that matters is "never lets the handler run" — a route that
  executed and then answered 404 would satisfy every status assertion and have
  already done its work.
- **A test can pass for the wrong reason and look like proof.** 2.2's withdrawal
  test — admit an operator, withdraw the status, refuse the same credential —
  survived a guard deliberately broken to cache its first verdict per route.
  Withdrawing operator status makes the resolver return *no principal at all*,
  so the refusal came from the null-actor branch and never reached the cache.
  The discriminating pair is one caller admitted and a different caller refused
  on the same route, in a single test rather than across two that happen to run
  in that order. Found by breaking the guard, not by reading the test.
- 6.3 is split on purpose: that the *resolver* re-reads operator status per
  request is feature 2's claim, already proven end to end in
  `operator-boundary.integration-spec.ts`. What 2.2 asserts is narrower and is
  the only part this feature owns — that the guard adds no memory in front of it.
- **"A member of another tenant" is not a state the system can produce.** The
  first version of 2.3's stranger test built an actor carrying Globex while
  addressing Acme's route, and the guard admitted it — correctly, because that
  actor is coherent. It is also impossible: the middleware takes the tenant from
  the path, so an actor's tenant always *is* the path's. A stranger is a person
  whose membership lives elsewhere reaching a path that names Acme, and the
  refusal comes from finding no membership here. The matrix in 5.3 has to be
  built the same way or it will assert against actors the platform cannot make.
- The guard reuses `authorizeInTenant` rather than restating the rule, so the
  two layers reach the same verdict from the same code and differ only in which
  transaction they read in. That also settles 5.3's logging without touching the
  application layer: the error filter already logs the violation's kind, so
  `forbidden` and `not-found` are distinguishable in the log while identical in
  the response. Adding reasons inside `authorizeInTenant` was considered and
  proved unnecessary.
- The guard is now `async`. `canActivate` returning a promise is ordinary for
  Nest, but it means every guarded tenant route awaits a transaction before the
  handler starts — the cost 2.5 has to measure.
