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

- [x] 2.4 Refuse machine callers unless a route admits them
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

- [x] 2.5 Measure what the guard's resolution costs
  - Time a tenant-scoped request with the guard resolving and with it short-
    circuited, on this machine, against the local database
  - Record the figure in the Implementation Notes, so the transaction decision
    is one that was measured rather than assumed
  - Done when the note states both figures and the difference, and says whether
    it changes the design's answer
  - _Requirements: 4.3_
  - _Boundary: Access guard_

## 3. What the use cases enforce, said out loud

- [x] 3.1 Name the roles each tenant-scoped use case enforces, and widen the
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
  - Withhold every email address from a caller who is not an administrator
    here, so widening who may read the listing discloses nothing requirement
    10.3 of `tenant-and-user-management` reserves to administrators. The
    decision belongs to the use case, which already knows the caller's role
  - _Requirements: 2.1, 2.1.1, 4.2_
  - _Boundary: Application use cases_

## 4. Declare the routes, then turn the guard on

Declaration comes first on purpose. Registering the guard while routes are still
undeclared would refuse them — correctly, and catastrophically for the suite —
so 4.5 is last and is the task that makes the feature live.

- [x] 4.1 (P) Declare the authentication routes reachable without a principal
  - All four credential endpoints, each stating it explicitly rather than
    inheriting anything
  - Done when signing in still works with no credential presented
  - _Requirements: 1.5_
  - _Boundary: Authentication controller_

- [x] 4.2 (P) Declare the operator routes
  - Provisioning, listing and deactivating a tenant; deactivating a person;
    issuing a setup token
  - Done when all five carry an operator declaration and the inventory reports
    no undeclared route among them
  - _Requirements: 1.6_
  - _Boundary: Tenants, platform people and credential setup controllers_

- [x] 4.3 (P) Declare the tenant member routes
  - Listing declares all three roles; creating, re-roling and revoking declare
    the administrator
  - Done when a viewer can list the tenant's members through the route and is
    refused all three mutations
  - _Depends: 3.1_
  - _Requirements: 2.1, 2.2_
  - _Boundary: Tenant members controller_

- [x] 4.4 (P) Declare the API key routes
  - All three declare the administrator, reading included
  - Done when an editor and a viewer are both refused the listing
  - _Requirements: 2.3_
  - _Boundary: API keys controller_

- [x] 4.5 Register the guard for every route
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

- [x] 5.1 Prove no route is undeclared, and no declaration is meaningless
  - Assert every route in the assembled application carries a declaration, and
    name the offenders when one does not
  - Assert no declaration is self-contradictory or permits nobody, and that no
    shipped route admits machines
  - Done when removing one route's declaration fails this test with that route
    named, and the failure is legible enough to act on without opening the file
  - _Requirements: 1.2, 3.4, 6.2_
  - _Boundary: Route inventory tests_

- [x] 5.2 Prove the declared roles and the enforced roles have not drifted
  - Compare each route's declared roles against the value the use case behind it
    enforces; for operator routes, compare the declaration against the use case
    requiring an operator
  - Done when widening a declaration without widening its use case fails this
    test, and widening the use case without the declaration fails it too
  - Not `(P)`: it shares the inventory suite with 5.1
  - _Depends: 3.1_
  - _Requirements: 4.2_
  - _Boundary: Route inventory tests_

- [x] 5.3 Prove the matrix: every role, every route, refused in every direction
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

- [x] 5.4 (P) Prove a refusal still discloses nothing
  - Assert a refusal for the wrong role and a refusal for no membership at all
    are identical in status and body
  - Assert the reason for each appears in the log and in no response
  - Done when the pair is byte-identical and the assertions fail if either
    refusal starts reporting its cause
  - _Depends: 4.5_
  - _Requirements: 5.1, 5.2, 5.3, 5.5_
  - _Boundary: Disclosure tests_

- [x] 5.5 (P) Prove the second layer stands on its own
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
- **A machine's tenant and the path's can disagree; a person's cannot.** The
  middleware puts the path's tenant on a person's actor, so for people the two
  are the same value by construction. A key carries the tenant it was issued
  into, so the guard has to compare them itself. Read from
  `request.params.tenantId` rather than by matching the URL: a guard runs after
  routing, so the parameter is populated and is the precise source, unlike the
  middleware upstream which runs before matching and needs a pattern.
- A route that admits machines but names no tenant has nothing to compare a key
  against, so `tenantInPath` returns null and the key is refused. Fail-closed on
  a shape no route has today, rather than a special case nobody would maintain.
- The three machine checks were each broken separately to confirm each has its
  own failing test — the "wrong tenant" and "wrong role" cases had both passed
  before the pass landed, via the fail-closed branch, so passing afterwards
  proved nothing on its own.
- **The guard's resolution costs ~6 ms per tenant-scoped request** on this
  machine (Docker PostgreSQL on localhost, 50 iterations, warm pool):

  | | ms/request |
  |---|---|
  | guard resolving a membership | 6.05 |
  | guard short-circuiting on a public route | 0.00 |
  | the transaction alone, empty | 1.11 |
  | the three reads | 4.94 |

  Broken down further, over an 0.87 ms empty-transaction baseline:
  `tenants.findCurrent` 2.32, `people.findById` 4.19, `memberships.findByPerson`
  3.75. **`people` is the slowest because its row-level security policy runs an
  `EXISTS` against `memberships` for every candidate row**, so reading a person
  also costs a membership lookup. That is migration 0001's design working as
  intended, not a defect, and it costs the same inside the use case's
  transaction.
- **The figure that actually matters is double this.** The use case repeats the
  same three reads in its own transaction, so a tenant-scoped request now pays
  roughly 12 ms of authorization rather than 6. That is the true price of two
  layers that do not share a point of failure, and it was worth stating plainly
  rather than reporting only the guard's half.
- **Verdict: the transaction decision stands.** For a dashboard API answering
  human-paced requests, 12 ms is affordable and buys refusal before application
  logic plus an independent second layer. It is the first thing to revisit if a
  latency budget ever appears, and the alternatives are already written down in
  `research.md` — sharing the resolution was rejected because it would make the
  second layer depend on the first.
- 2.5 is a measurement, not a behaviour, so it has no RED phase: there was
  nothing to fail first. The spec keeps a deliberately generous ceiling (50 ms)
  that will never trip on a busy laptop but does catch a lost index or a
  resolution that starts issuing a query per membership.
- **3.1 hit a conflict between two approved requirements and stopped.** Widening
  the member listing to editor and viewer contradicts requirement 10.3 of
  `tenant-and-user-management` — a person's email address is reserved to
  administrators of a tenant they belong to — because the listing carries every
  member's address. The use case even said so in its own docstring, written in
  feature 1, and neither the requirements phase nor the design phase noticed.
  Settled with Camilo on 2026-08-15: **10.3 stands, and the listing withholds
  addresses from non-administrators.** Requirement 2.1.1 and a design section
  were written before any code, rather than after.
- The rule lives in the use case, not the response mapper. What a caller may
  learn is a rule about access, and the layer that just resolved their role to
  answer at all is the one that knows it.
- The response omits `email` entirely rather than sending `null`, so a listing
  without addresses says "not for you" instead of implying these people have
  none.
- Incidental tightening: the use case used to return the repository's
  `MembershipWithPerson`, which carries the raw membership status the route
  never published. `ListedMember` publishes exactly what the route answers with
  — `active`, not `status` — so two integration specs that had been reaching
  through to `.membership.status` now assert what a caller can actually see.
- One existing edge test had used "a viewer listing members" as its example of a
  denial. That is no longer a denial, so it now uses the API keys, which remain
  the administrator's alone. A test whose premise a feature removes has to be
  re-aimed, not deleted.
- All sixteen declarations landed under one RED: the inventory test written in
  1.2 had an assertion marked provisional — "every route declares nothing, for
  now" — and section 4 is what inverts it. It now restates the design's
  declaration table where a machine checks it, so a route declared differently
  from the design fails with the route named.
- **The declarations are inert until 4.5.** Nothing reads them yet, so these
  four tasks prove the declarations are present and correct, not that they are
  enforced. The suites passing here says the application still behaves exactly
  as it did — which is the point of declaring before registering.
- A scripted edit inserted the decorator import in the middle of a multi-line
  import statement, because "the last line starting with `import`" is not the
  end of the import block. The build caught it immediately; worth remembering
  that this repository's controllers all open with multi-line imports.
- **The feature is live as of 4.5, and the suite went green on the first run.**
  That is the payoff of declaring all sixteen routes before registering
  anything: had a declaration been wrong, it would have surfaced here as a
  broken route rather than as a silent hole.
- Proved by mounting a route the application does not ship, declaring nothing,
  and expecting a refusal — which only a globally registered guard can produce.
  `createInMemoryApplication` gained a `controllers` option for it: proving that
  an undeclared route is refused needs an undeclared route, and the sixteen real
  ones are all declared.
- **Requirement 1.3 verified by breaking, and it is the sharpest check in the
  feature**: narrowing the member listing's declaration to `admin` alone refuses
  a viewer through the real application *while the use case still permits all
  three roles*. The declaration drives the outcome, and nothing behind the route
  changed.
- **Smoke against `node dist/main.js`**, which is where the two layers became
  visible as two. Both requests answer 404 and the log tells them apart:
  `GET /tenants` with no credential logs "this route needs a principal and none
  was resolved" — the guard, before the handler — while `POST /auth/sign-in`
  logs "no credential for this address", which only the use case can say. The
  public declaration let one through and the guard stopped the other, and the
  caller cannot tell which happened.
- **5.1's RED could not come from the test failing** — the application already
  satisfies it. It came from the condition the task actually names: that the
  failure be legible. Verified by removing one declaration and *reading the
  output*, which prints
  `DELETE /tenants/:tenantId/api-keys/:apiKeyId — ApiKeysController.destroy`.
  Actionable without opening a file.
- **`Access` validates when the module is imported, so an unusable declaration
  crashes startup rather than failing a test.** Discovered while trying to break
  the "no meaningless declaration" assertion: making the check stricter stopped
  the suite from loading at all, with the stack pointing at
  `credential-setup.controller.ts` being imported. The assertion therefore
  guards a narrower case than it looked like it did — metadata attached with
  `SetMetadata` directly, bypassing `Access`, which is exactly what a
  well-meaning developer reaches for. A test now proves it catches that.
- `assertUsable` is exported from the decorator (it was the private `reject`) so
  the suite asks the same question of what is actually attached, rather than
  trusting that everything went through `Access`.
- The undeclared-route test and the declaration table say the same thing today,
  because the table lists all sixteen. They diverge the moment a route is added:
  the table needs a hand, this one does not. That is why both exist.
- **Nothing in the running system links a route to the use case behind it**, so
  the pairing is stated in the drift spec. It is not a third list to keep in
  step: the role constants are imported, so renaming or deleting one fails the
  build rather than the test. Two further assertions stop the table going stale
  — every route that names roles, and every route declared for an operator, must
  appear in it, so a route added later cannot escape the comparison.
- Both directions of drift were verified: widening a declaration without its use
  case fails, and widening a use case without its declaration fails. That is
  what makes the two layers independent *and* consistent — a deliberate change
  has to be written twice, which is the friction a security rule deserves.
- **A source-presence check was satisfied by an unused import.** The operator
  routes have no value to compare, only a call, so the spec greps the use case's
  source. Grepping for `requirePlatformOperator` survived deleting the call,
  because the import line still mentioned it — found by breaking, not by
  reading. It now greps for `requirePlatformOperator(`, which does not appear in
  an import.
- **The status matrix passes with the guard unregistered, and that is the
  finding.** Every principal it refuses is refused identically by the use case
  behind the route, so no status can tell which layer answered. That is not a
  weakness in the matrix — it is the two layers being genuinely independent, and
  it is the strongest evidence so far that requirement 4.1 holds. It does mean
  the matrix proves a claim about the *system* and not about the guard.
- So one test asks the log instead, which is where the design put the
  distinction. Unregister the guard and it alone fails, while all eighteen other
  cases stay green. **First probe was wrong**: an operator calling
  `/tenants/{id}/api-keys` resolves as a *tenant member*, because the path names
  a tenant and feature 2's resolver reads it that way deliberately. The probe
  that works is a tenant member on `GET /tenants`, a path with no tenant in it.
- The suite walks the routes the inventory reports, not a list written by hand,
  and a coverage test compares the two. A route added later is reported by the
  inventory and fails here by name until it is covered.
- Refusals are asserted as `{ principal, status }` pairs rather than bare
  statuses, so a failure names who was wrongly admitted instead of printing
  `expected 404, received 200` with no clue which of six callers it was.
- **`authorizeInTenant` was throwing without reasons, and 2.3's note that adding
  them "proved unnecessary" was wrong.** It was true for 2.3's needs and false
  for requirement 5.3, which asks that the reason for every refusal be recorded.
  The log was saying only `forbidden` or `not-found`, leaving an operator to
  guess which of four access refusals had happened while `decideAccess` had
  already worked it out and discarded it. Now each refusal carries its cause.
- Found by breaking, in a roundabout way: leaking `reason` into the response
  body did *not* fail the byte-identical test, because both refusals had no
  reason to leak. A break that fails less than expected is worth reading rather
  than moving past.
- **A stranger's refusal logs "no such person", not "no membership".** From
  inside the tenant's transaction, row-level security has already hidden a
  person who belongs to another tenant, so the access decision never runs on
  them — the second isolation layer answers first. The test asserts what
  actually happens rather than what the authorization code would have concluded.
- The comparison covers headers as well as status and body, minus the three that
  are volatile by design. A refusal that differed only in a header would
  otherwise pass a body comparison and still be an oracle.
- **The two layers were finally proved independent in both directions.** Delete
  a use case's own check: this spec fails naming the operation, and the role
  matrix still passes because the guard covers it. Delete the guard's
  registration (5.3): the matrix's log test fails and this spec is untouched —
  by construction, since it boots no application and imports no module. Each
  layer has a witness the other cannot satisfy, which is what "no shared point
  of failure" has to mean to be worth claiming.
- The six administrative operations are collected rather than asserted one at a
  time, so a failure names the operation that let the caller through instead of
  stopping at the first. Removing one check printed `"listing API keys"`, which
  is the whole diagnosis.
- One test admits the administrator on purpose. Without it, six refusals would
  pass just as well against a layer that refused everybody.
