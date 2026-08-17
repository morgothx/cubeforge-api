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

- [ ] 1.2 Resolve a person on a path that names no tenant
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

- [ ] 2.1 Add the declaration shape
  - A fourth shape saying a route admits any caller who names a person,
    alongside public, operator and roles
  - Refuse it combined with anything else, the way every other illegal
    combination is refused — at construction, when the module is imported
  - Done when the shape can be attached and read back, and combining it with
    another fails a test that names which combination it was
  - _Requirements: 3.4_
  - _Boundary: Access declaration_

- [ ] 2.2 Enforce it
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

- [ ] 3.1 Publish a person into a transaction, and let a policy confine the read
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
  - Re-aim the role matrix's guard probe, whose message task 1.2 changed
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
  **That run reports 34 pre-existing errors across nine spec files**, most from
  features 1 and 2 — recorded here rather than fixed, because they are outside
  this task's boundary and their repair is Camilo's call.
