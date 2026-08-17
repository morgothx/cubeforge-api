# Implementation Tasks — caller-identity

Ordering follows Foundation → Core → Integration → Validation. Task N implicitly
depends on everything before it; `_Depends:_` marks only non-obvious or
cross-group dependencies. `(P)` marks tasks safe to run concurrently with their
immediate peers.

The endpoint is last on purpose. Three mechanisms have to exist before there is
anywhere for it to live, and each is useful to state on its own.

## 1. A person acting in no tenant

- [x] 1.1 Give the actor union its fourth kind
  - Add a principal that names a person and no tenant, distinct from the tenant
    member, which carries one and whose every check assumes it
  - Decide what each existing site that reads the actor kind does with it: the
    tenant authorization functions refuse it exactly as they refuse an operator,
    because a person acting in no tenant has no standing inside one
  - Give the test fixtures a way to build one, beside the operator they already
    build
  - Done when the project compiles with the new kind handled everywhere the
    compiler names, and the existing suites pass unchanged — nothing produces
    the new kind yet, so nothing should behave differently
  - _Requirements: 3.1_
  - _Boundary: Actor context_

- [x] 1.2 Resolve a person on a path that names no tenant
  - Where the resolver today answers "an operator, or nobody", answer "an
    operator, a person, or nobody"
  - Refuse anyone the platform no longer counts as active, whatever their
    operator record says — a deactivated person's token verifies until it
    expires, and until now no tenantless route existed for a plain person to
    reach with one
  - Take nothing from the credential but who presented it
  - **This changes an existing log line.** A tenant member on an operator route
    used to be refused for having no principal at all; now they are refused for
    being the wrong kind. One test in the role matrix probes exactly that line
    and must be re-aimed — it is the test noticing that what it probed changed
    meaning, not a regression
  - Done when an active non-operator resolves to a person, an active operator
    still resolves to an operator, a deactivated person resolves to nobody, and
    a path naming a tenant still resolves to a tenant member
  - _Requirements: 3.1, 4.3_
  - _Boundary: Principal resolver_

## 2. A route that admits any authenticated person

- [x] 2.1 Add the declaration shape
  - A fourth shape saying a route admits any caller who names a person,
    alongside public, operator and roles
  - Refuse it combined with anything else, the way every other illegal
    combination is refused — at construction, when the module is imported
  - Done when the shape can be attached and read back, and combining it with
    another fails a test that names which combination it was
  - _Requirements: 3.4_
  - _Boundary: Access declaration_

- [x] 2.2 Enforce it
  - Admit a person and an operator: both name a person, and the requirement
    admits a caller whether or not they hold any membership or operator status
  - Refuse a machine, which names a credential rather than a person, and refuse
    a caller with no principal — both as an absence, like every other refusal
  - Refuse a tenant member, whose request named a tenant and is therefore not
    the kind of request this shape describes
  - Done when all five principals get the answer above through a guarded route,
    and the handler behind it never runs for the refused ones
  - _Requirements: 3.1, 3.2, 3.3_
  - _Boundary: Access guard_

## 3. (P) Reading one person's rows, across tenants

Independent of section 2 — different files, different layer, no shared state.
The two can be built in either order.

- [x] 3.1 Publish a person into a transaction, and let a policy confine the read
  - Mirror the tenant mechanism exactly: a stable function reading a
    transaction-local setting, and a policy on memberships that admits only rows
    belonging to the published person
  - Grant the authenticating identity the read it needs and nothing more — this
    identity may never write a membership
  - Change no existing grant or policy
  - Done when, as the authenticating identity: publishing a person returns only
    their memberships from a query with no predicate of its own, publishing
    another person returns only that person's, and publishing nobody returns
    none. Deleting the policy's condition must fail that first assertion
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: Schema_

- [ ] 3.2 Read a caller's standing through it
  - Add the entry point that opens an authenticating transaction with a person
    published, leaving the existing one untouched — signing in runs before any
    person is known and has nobody to publish
  - Add the repository that reads the person, their operator record and their
    memberships with each tenant's name. **It takes no person**: the person is
    whoever the transaction published, which removes the shape of the mistake
    rather than forbidding it by convention
  - Provide the same contract in memory, so the use case can be tested without a
    database
  - Done when both implementations answer the same shape for the same fixture,
    and passing a person identifier into the read is not expressible
  - _Depends: 3.1_
  - _Requirements: 2.1, 5.2_
  - _Boundary: Persistence_

## 4. The answer itself

- [ ] 4.1 Describe a caller's standing
  - Report the person's identifier, their own address, whether the platform
    records them as an operator, and the tenants they belong to with the role
    held in each
  - Drop every membership that does not currently grant access, by asking the
    same access rule the guard and the use cases ask — so a tenant this reports
    is a tenant the caller can actually reach
  - Answer a caller who belongs nowhere with an empty list rather than a
    refusal: an empty answer is an ordinary answer, and refusing would tell them
    something about the platform's shape
  - Done when a member sees their tenants, an operator sees the flag and only
    their own memberships, a revoked membership and one in a deactivated tenant
    are both absent, and someone with no memberships gets the same shape as
    someone with three
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.2, 2.4_
  - _Boundary: Application use case_

- [ ] 4.2 Serve it
  - One route, declaring that it admits any authenticated person
  - Bind the use case and the controller where the feature's other bindings
    live, so the route exists in the assembled application rather than only in
    a test module
  - No route, and no argument to one, that names a person other than the caller
  - Done when a signed-in person receives their standing, and the route appears
    in the application's own inventory with the new declaration
  - _Depends: 2.2, 3.2_
  - _Requirements: 1.1, 2.3_
  - _Boundary: Caller controller_

- [ ] 4.3 Bring the new route into the suites that enumerate routes
  - Four existing suites list or count every route: the inventory's declaration
    table, its undeclared-route check, the drift check's two pairings, and the
    role matrix's coverage assertion. Each was written to fail when a route
    appears without them being told, and each will
  - ~~Re-aim the role matrix's guard probe, whose message task 1.2 changed~~ —
    **done in 1.2**, which is where the message changed and therefore where the
    tree would otherwise have been left red
  - Do not weaken an assertion to accommodate the new route — the whole point of
    those suites is that a new route cannot slip past them
  - **Sits here rather than in the validation section because 4.2 turns those
    four suites red the moment the route exists.** Grouping it with the route
    keeps the tree green at every checkpoint; deferring it would leave a task
    that "passes" with four suites failing
  - Done when every one of those suites accounts for the new route explicitly,
    and unregistering the guard still fails the probe
  - _Depends: 1.2, 4.2_
  - _Requirements: 3.4, 5.3_
  - _Boundary: Integration suites_

## 5. Validation

- [ ] 5.1 Prove it end to end, against the real database
  - A member, an operator, and a person holding different roles in two tenants
    each receive the right standing
  - A machine key and a caller with no credential are refused identically
  - Change a role, revoke a membership, deactivate a tenant, deactivate the
    person — each shows in the next answer with the credential unchanged
  - Done when every one of those holds through the assembled application, and
    the freshness assertions fail if the standing is read anywhere but at the
    moment of asking
  - _Depends: 4.2_
  - _Requirements: 1.1, 1.3, 2.4, 3.2, 3.3, 4.1, 4.2_
  - _Boundary: Caller standing tests_

## Implementation Notes

Findings recorded during implementation belong here, so the next feature
inherits them rather than rediscovering them.

- **The design was wrong about the compiler, and 1.1 is where it showed.** It
  claimed a fourth actor kind would make the compiler name every site that has
  to decide what the kind means. Nothing switches on `ActorContext`
  exhaustively: `unreachable` is used for `DomainError`, and every actor check
  is a negative comparison. Adding the kind compiled cleanly and named nothing.
  The behaviour is still right — negative comparisons fail closed — but it is
  right by the shape of the comparisons rather than by the type system, so the
  refusals are asserted in tests. The design has been corrected.
- **Type errors in spec files are invisible to `pnpm build` and `pnpm test`.**
  The build excludes `**/*spec.ts`, and `ts-jest` transpiles without checking.
  The first attempt at a RED for this task was an invalid `{ kind: 'person' }`
  in a spec, which *passed* — the object was never type-checked and the runtime
  behaved as the negative comparisons dictate. The real RED came from
  `npx tsc --noEmit -p tsconfig.json`, which is not wired to any script.
  **That run reported 34 pre-existing errors across nine spec files**, most from
  features 1 and 2. **Repaired between tasks 1.2 and 2.1**, on Camilo's
  decision, and `pnpm typecheck` now exists so the gap cannot reopen silently:
  - Six were one production defect, not a test defect. `JwtAccessTokenIssuer`
    did not declare `implements AccessTokenIssuer`, and returned a bare `string`
    where the port promises a branded `AccessToken`. Nest's `useFactory` accepts
    a provider that merely resembles its token, so nothing objected — and
    `accessToken()` was called nowhere in the whole repository. The brand
    existed in the port and in `EstablishedSession` and was applied by no one.
    **Adapters must declare `implements` on the port they satisfy**; DI does not
    check it for you.
  - Twenty-two were test helpers annotated `Promise<string>` while returning
    `PersonId`. One annotation per helper; the branded type flows from there.
  - Three were **accidental globals**: `administrator`, `editor` and `viewer`
    were assigned in `access.guard.spec.ts` and declared nowhere. ts-jest emits
    CommonJS, which is not strict mode, so the assignment created a global and
    the suite passed. All three were write-only — the tests address those
    principals by string literal.
  - One was a `personId` property passed to `seedMember`, which takes no person.
    Silently ignored; the fixture resolves the person from the address, which is
    what made the test correct despite it.
- **`isOperator` conflates "not an operator" with "not active", and reading it
  alone would have been a privilege escalation.** It joins `people` and requires
  `status = 'active'` — feature 2's fix — so it answers `false` for a
  deactivated operator, indistinguishable from an ordinary member. The obvious
  implementation of 1.2, `isOperator ? operator : person`, therefore resolves a
  deactivated operator to a **person** and hands them every route open to one:
  deactivating a compromised operator would have granted access rather than
  removed it. The status check has to be its own read and has to come first.
  Removing it fails two tests in `principal-resolver.spec.ts`.
- **No new port was needed for the status check.** `credentials.findByPerson`
  already exists for exactly this: its doc says refreshing "starts from a token,
  not an address, and still has to know whether the person behind it has been
  deactivated". A tenantless request is the same situation. It costs one extra
  query in the same transaction, and returns a password digest this caller
  discards — worth folding into the standing read of task 3.2 if that read ends
  up covering it.
- **Two tests in that spec pass before the implementation and are load-bearing
  after it.** A deactivated person and an unknown person both resolved to `null`
  already, because *every* non-operator did. They only become assertions about
  the active check once a non-operator resolves to something — which is why the
  probe that deletes the check is the evidence, not the initial RED.
- **The role-matrix guard probe was re-aimed here rather than in 4.3**, which
  also lists it: 1.2 is what changes the message, so deferring would have left
  the tree red at a checkpoint. It now looks for `this route is for operators;
  this caller is a person`, which is still a line only the guard produces.
- **The declaration union *does* make the compiler name every site — the exact
  opposite of the actor union in 1.1, and for a reason worth keeping.** Adding
  `{ person: true }` broke `access.guard.ts` in three places immediately. The
  difference is how each union is read: the guard narrows the declaration
  **positively** (`'public' in declaration`, `'operator' in declaration`) and
  then uses the residual, so a new member changes that residual's type. The
  actor union is read through **negative** comparisons (`!== 'tenant-member'`),
  which keep compiling whatever is added. Positive narrowing is what buys the
  compiler's help; that is a design lever, not a property of unions.
- **The guard had to say something about the new shape in 2.1, before 2.2 gives
  it a rule.** It refuses, which is the rule this guard was built under, and
  `access.guard.spec.ts` pins the refusal for all four principals. **Task 2.2
  replaces that block**; it is there so the interval between the two tasks is
  closed rather than merely short.
- **The refusal tests in `access.decorator.spec.ts` were being satisfied by the
  error's own echo, not by its reason.** Every message ends with the JSON that
  was written, so `/person.*machines/` matches
  `{"person":true,"machines":true}` regardless of what the check concluded —
  and one of the four new tests passed before the branch it was written for
  existed. They now assert against the reason with the echo stripped, and the
  pre-existing tests in that block had the same weakness and were converted too.
  One test still asserts the echo, deliberately, because reporting what was
  written is the only clue an import-time failure has.
- **The `person` branch opens no transaction, and that is the point of where it
  sits.** Every other non-public declaration ends in a read: the roles branch
  opens a tenant transaction to resolve a membership, and the machine branch
  compares the key's tenant against the path. This one asks only what kind of
  credential was presented, because requirement 3.1 admits a caller regardless
  of standing — so it is the cheapest branch in the guard, and the only one
  whose answer cannot go stale between the guard and the use case behind it.
- **Four of this task's six tests passed before the implementation**, because
  2.1 left the branch refusing everything. Three probes were needed to make them
  mean something: admitting every kind fails two of them, admitting machines
  fails one, admitting tenant members fails the other. Blanket-refusal is the
  same failure shape as the deactivated-operator case in 1.2 — a test that
  passes because *nothing* is admitted proves nothing about who is.
- **Two of the six can never fail through this branch at all.** A caller with no
  credential and a caller whose standing was withdrawn are both refused earlier,
  by the guard's null check and by the resolver respectively. They are asserted
  here anyway: "admits any person" must not quietly become "admits any past
  person", and the assertion belongs on the first route a plain person reaches.
- **An existing test asserted the *absence* of this grant, and the tasks did not
  predict it.** `authenticator-adapters.integration-spec.ts` asserted
  `permission denied for table memberships` as the boundary of the
  authenticating identity — the research recorded that the grant was missing
  but not that a test had frozen the absence. Granting `SELECT` turned it red.
  Re-aimed rather than deleted: the boundary moved, it did not dissolve, so the
  test now asserts that the read discloses nothing with nobody published and
  that this identity still cannot *write* a membership. Task 1.2 flagged its
  equivalent in the role matrix in advance; this one had to be found by running
  the suite.
- **A migration written before its test is not a RED, and the probes are the
  real evidence.** The new suite passed on its first run, because global setup
  had already applied the migration. Three probes supply what the ordering did
  not: `USING (true)` fails three tests, dropping the policy fails two, and
  revoking the grant fails three. The strongest is `USING (true)` — it fails
  the with-nobody-published assertion, which no query-level predicate would
  have caught.
- **The confinement is keyed on the person, and the fixture is built so that a
  wrong key still fails.** Both people in the fixture share a tenant, so a
  policy accidentally written against `tenant_id` would satisfy "the caller
  sees two rows" and be caught by "the other person sees one".
