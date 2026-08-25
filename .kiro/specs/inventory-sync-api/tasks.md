# Implementation Tasks — inventory-sync-api

Ordering follows Foundation → Core → Integration → Validation. Task N implicitly
depends on everything before it; `_Depends:_` marks only non-obvious or
cross-group dependencies. `(P)` marks tasks safe to run concurrently with their
immediate peers.

## 1. The ground everything else stands on

The tables, the rules the database itself enforces, and the one shared seam.
Section 1.3 touches a file every later section reads, so it goes first and
nothing waits on it afterwards.

- [x] 1.1 Give a tenant somewhere to keep products, places and movements
  - Three tenant-owned tables, each carrying its tenant explicitly rather than
    reaching it through a join, because that is the column both the repository
    predicate and the isolation policy key on
  - A product is unique by the tenant's own SKU and a place by the tenant's own
    code, so two tenants may each use `ACME-001` for unrelated things
  - A movement is unique by the identifier its source system supplied, **within
    a tenant** — the constraint that makes a retry safe, and the reason the same
    identifier arriving from a different tenant is not a conflict
  - A movement references its product and its place by a key that carries the
    tenant, so a movement pointing at another tenant's product cannot be
    written even if a policy were misapplied
  - Store both when a movement happened and when the platform recorded it: the
    first is the business fact, the second only ever moves forward and is what a
    later export will read incrementally
  - Refuse a zero quantity and an unrecognised kind at the table, not only above it
  - Done when the migration applies to a clean database, both uniqueness rules
    reject a duplicate, and a movement naming a product from another tenant is
    refused by the foreign key
  - _Requirements: 1.3, 3.2, 3.4, 5.1, 7.6_
  - _Boundary: Persistence schema_

- [x] 1.2 Make the history impossible to rewrite
  - Enable and force row-level security on all three tables, following the
    pattern the identity and credential tables already use
  - Scope every policy to the tenant published for the transaction
  - Grant the application the right to read and insert everywhere, and to update
    only the two reference tables
  - **Grant no deletion anywhere, and no update on movements.** Append-only is
    enforced by the absence of a grant, not by remembering not to write the
    method — a repository can be added later, a grant cannot be forgotten into
    existence
  - Done when the application identity is refused an update and a delete on
    movements by the database itself, and a tenant reading with another
    tenant published sees nothing
  - _Requirements: 1.5, 2.4, 3.6, 7.2_
  - _Boundary: Persistence schema_

- [ ] 1.3 Widen the tenant-scoped seam to carry inventory
  - Add the three new repositories to the set handed to work running inside a
    tenant, in both the real and the in-memory implementations
  - Introduce no second way to reach persistence: the existing seam hands
    repositories to a callback precisely so there is no construction path that
    skips the tenant, and a second path would be worth exactly as much as the
    number of ways around the first
  - Done when a use case can obtain all three inside a tenant and cannot obtain
    any of them outside one, and the existing suite still passes
  - _Requirements: 7.2_
  - _Boundary: TenantScopedUnitOfWork_

## 2. What a movement is, decided without a database

Pure rules, testable without a container. This is where the properties the
project exists to demonstrate stop being framework behaviour.

- [ ] 2.1 Name the things a tenant refers to
  - Distinct identifier types for a SKU, a place code and a source-system
    movement identifier, so one cannot be passed where another is meant
  - Refuse an empty identifier, one longer than permitted, and one carrying
    characters outside the permitted set, naming which rule refused it
  - Done when each constructor rejects every malformed shape with the reason
    named, and the compiler refuses a SKU used as a place code
  - _Requirements: 1.4_
  - _Boundary: Inventory domain_

- [ ] 2.2 Judge a movement on its own terms
  - One pure judgement over a submitted movement and the current moment,
    answering admissible or refused-for-this-reason
  - Accept only the three kinds the requirements name, and offer no kind that
    names two places — a transfer is two movements, and the absence is the
    mechanism
  - Require an arrival to be positive and a sale negative, permitting an
    adjustment either way; this is the rule that catches an integration which
    inverted its sign convention, a failure that otherwise surfaces months
    later as a total that runs backwards
  - Refuse a quantity that is zero, fractional, or beyond the permitted
    magnitude
  - Refuse a movement claiming to have happened later than now, and accept one
    from the past, because a nightly synchronisation reports yesterday
  - Collect every refusal reason into one closed set, so a caller can act on a
    reason programmatically instead of matching prose
  - Done when each rule has a test that fails when only that rule is removed,
    and the set of reasons is exhaustive over the judgement's own outcomes
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.8, 9.2_
  - _Depends: 2.1_
  - _Boundary: Inventory domain_
  - Not parallel with 2.1: a submitted movement is expressed in the identifier
    types that task defines

## 3. The things movements point at

Two entities of one shape. The interface is shared; the implementations stay
two small concrete repositories rather than a base class.

- [ ] 3.1 (P) Keep a tenant's product catalogue
  - Declaring a product that is not present records it; declaring one that is
    replaces its describable attributes, and the caller is told which happened
  - Answer which of a set of SKUs are declared, returning membership rather than
    rows, because that is the only question asked before an insert and returning
    records nobody reads is an invitation to read them
  - Offer no way to delete: movements already recorded point at it, and the
    history has to stay readable
  - Provide both the real implementation and the in-memory one used by tests
  - Done when re-declaring reports an update rather than a second product, two
    tenants hold the same SKU independently, and no deletion path exists
  - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - _Depends: 1.3_
  - _Boundary: ProductRepository_

- [ ] 3.2 (P) Keep a tenant's places
  - The same shape as the catalogue: declare, replace, answer membership, never
    delete
  - Done when re-declaring reports an update, and the membership answer is what
    a later movement check consumes
  - _Requirements: 2.1, 2.2, 2.4_
  - _Depends: 1.3_
  - _Boundary: LocationRepository_

## 4. Recording what happened

- [ ] 4.1 Record movements without racing a retry
  - Insert the movements given, skipping any whose source-system identifier is
    already recorded in this tenant, and report back exactly which ones were
    newly recorded
  - Let the uniqueness constraint do the skipping and merely observe its
    outcome. **Do not read first and insert second** — that is a race two
    concurrent retries of the same batch will eventually lose, producing the
    duplicate the whole requirement exists to prevent
  - Provide the in-memory implementation with the same semantics, so an
    application test can distinguish a first submission from a replay
  - Done when submitting the same movements twice records them once and reports
    the second attempt as recording nothing new
  - _Requirements: 5.1, 5.2_
  - _Boundary: MovementRepository_

- [ ] 4.2 Turn a batch into an answer about every row
  - Decide everything decidable without the database first — the per-movement
    judgement, then identifiers duplicated within this same batch — so a batch
    that is entirely malformed costs one round trip and no writes
  - Reject a row naming a product or a place the tenant has not declared, and
    let the rest of the batch through
  - Treat a duplicate **inside one batch** as a rejection rather than a replay:
    a client that batched the same document twice has a bug, and it is a
    different fact from a caller retrying a request
  - Return one outcome per submitted movement, in submission order, each saying
    recorded, already recorded, or refused for a named reason — the report
    cannot be shorter than what was sent, which is what stops a client reading
    a successful response as "all rows landed"
  - Distinguish already recorded from recorded, so a caller can tell a
    successful retry from a successful first attempt
  - Serve the single-movement case by submitting a batch of one, so the two
    routes cannot drift apart
  - Done when a batch of many with three bad rows records the rest and names
    each refusal by position, and re-submitting a mixed batch records only the
    rows that were new
  - _Requirements: 2.3, 3.1, 3.7, 4.1, 4.2, 4.4, 4.5, 5.3, 5.4, 5.5_
  - _Depends: 3.1, 3.2, 4.1_
  - _Boundary: recordMovements use case_

- [ ] 4.3 (P) Answer what is on hand
  - Sum the movements recorded for the tenant, per product and place
  - Report a pairing whose movements cancel out as zero rather than omitting it
  - Permit a negative result, and refuse no sale for taking stock below zero:
    the platform records what a source system reports, and deciding what is
    possible in that system's warehouse is not its job
  - Done when a product received and then sold in equal quantity appears with
    zero, and a sale exceeding what arrived is recorded and reported negative
  - _Requirements: 6.1, 6.2, 6.3_
  - _Depends: 1.3, 4.1_
  - _Boundary: MovementRepository, readStockOnHand use case_

## 5. Reaching it over HTTP

- [ ] 5.1 (P) Expose the catalogue and the places
  - A route to declare each and a route to list each
  - Declare who may reach them: writing needs an administrator or an editor,
    reading admits a viewer, and **all of them admit a machine credential** —
    these are the first routes on the platform to say so
  - Keep these payload shapes in their own file, apart from the movement
    payloads, so this task and 5.2 do not edit one file concurrently
  - Done when every route carries an explicit declaration and the existing
    declaration-drift check still passes
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 7.3, 7.4_
  - _Depends: 3.1, 3.2_
  - _Boundary: HTTP inventory controllers_

- [ ] 5.2 Expose recording, one and many
  - A route for a single movement and a route for a batch, both rendering the
    per-row report
  - Cap the batch at five hundred and refuse a larger one **whole**, through the
    ordinary payload validation, so a caller cannot mistake a size refusal for a
    data problem
  - Keep per-row refusals out of the error channel entirely: a thrown error is
    the whole response, and a batch outcome is per row. The existing error
    filter keeps whole-request failures and never sees a row
  - Name the field or rule responsible in every refusal, drawn from the closed
    set, and never mention anything the caller may not read
  - Done when a batch of five hundred and one is refused without recording
    anything, and a batch with bad rows returns a per-row report rather than an
    error
  - _Requirements: 4.3, 9.1, 9.2, 9.3_
  - _Depends: 4.2_
  - _Boundary: HTTP inventory controllers_

- [ ] 5.3 (P) Expose stock on hand
  - One read route, admitting a viewer and a machine credential
  - Done when a viewer's credential can read it and cannot write anything
  - _Requirements: 6.1, 7.4_
  - _Depends: 4.3_
  - _Boundary: HTTP inventory controllers_

- [ ] 5.4 (P) Slow a caller synchronising too eagerly
  - Limit requests per credential over a window, extending the throttling
    approach the credential endpoints already use rather than building a second
    limiter
  - Count against the credential, not the network origin or the tenant, so one
    integration exhausting its allowance cannot silence another integration in
    the same tenant
  - Tell a refused caller how long to wait, and record nothing for a refused
    request, so retrying after the stated wait loses nothing
  - Keep the numbers in configuration beside the existing ones; the default
    allowance must let a nightly synchronisation of thirty thousand movements
    through without special arrangement
  - Done when exceeding the allowance is refused with a wait and records
    nothing, and a second credential in the same tenant is unaffected
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - _Boundary: InventoryThrottlerGuard_

- [ ] 5.5 Wire the feature into the running application
  - Bind these ports to these adapters in a module of their own and import it
  - Confirm every new route appears in the inventory the platform walks, each
    with a declaration, so a route added without one cannot ship
  - Done when the application starts with the feature present, every new route
    is listed with its declaration, and a request carrying no credential is
    refused before reaching a controller
  - _Requirements: 7.1_
  - _Depends: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: Module wiring_

## 6. Proving the properties, not the happy path

Against a real database with real isolation, because that is the only place
these claims are true or false.

Each of these writes its **own** spec file rather than adding to a shared one;
four tasks appending to a single file are not parallel however unrelated their
assertions are.

- [ ] 6.1 Travel the machine path for the first time
  - Exercise **every** inventory route with a real API key, not only with a
    person's token
  - This path was designed, built and unit-tested, and no shipped route has ever
    set it; an untravelled path is an untested one however green its unit tests
  - Confirm an editor's key may write, a viewer's key may not, and a key with no
    standing reaches nothing
  - Done when every route has been reached by a real key and each refusal is by
    the guard rather than by a controller
  - _Requirements: 7.1, 7.3, 7.4_
  - _Depends: 5.5_
  - _Boundary: Integration suite_

- [ ] 6.2 (P) Show that one tenant cannot perceive another
  - Two tenants holding the same SKU see only their own products and movements
  - Referencing another tenant's product answers **exactly** as referencing one
    that exists nowhere — asserted by comparing the two responses to each other
    rather than to an expected string, so the two cannot drift apart later
  - A movement whose source-system identifier is already recorded in a different
    tenant is recorded, not refused: uniqueness is a property within a tenant,
    and refusing would disclose the other tenant's contents
  - Done when all three hold against the real database with isolation forced
  - _Requirements: 1.3, 7.2, 7.5, 7.6_
  - _Depends: 5.5_
  - _Boundary: Integration suite_

- [ ] 6.3 (P) Submit the same batch twice at the same time
  - Two concurrent submissions of one batch record each movement exactly once
  - This is the test that fails under a read-then-write implementation and
    passes under the constraint, which is the whole reason 4.1 is written the
    way it is
  - Done when it passes repeatedly under concurrency and is shown to fail if the
    uniqueness constraint is dropped
  - _Requirements: 5.1, 5.5_
  - _Depends: 5.5_
  - _Boundary: Integration suite_

- [ ] 6.4 (P) Show the history cannot be rewritten
  - The application identity is refused an update and a delete on movements, and
    a delete on both reference tables, by the database rather than by the code
  - A mistake corrected by an offsetting movement leaves both movements present
    and the sum correct
  - Done when each refusal comes from the database, and the offsetting case
    shows the error still visible beside its correction
  - _Requirements: 1.5, 2.4, 3.6, 3.7_
  - _Depends: 5.5_
  - _Boundary: Integration suite_

## Implementation Notes

### 1.1 and 1.2 could not land separately

The platform has a standing test asserting that **every** table has row-level
security enabled and forced, and at least one policy. Adding three tables
turned it red, which is exactly what it was built to do. So 1.1 alone leaves
the suite failing; the two are one checkpoint, not two.

Worth keeping in mind for the remaining foundation work: a task is only
independently completable if the suite is green at its end.

### The composite foreign key earns its keep immediately

`stock_movements` references `(tenant_id, sku)` rather than `sku`. The first
version of the cross-tenant test passed for the wrong reason — the helper gave
both tenants the same SKU, so the movement resolved against the *other* tenant's
identically named product and the foreign key was never tested. Giving each
tenant distinct codes turned it red, and then it failed again for a second
reason: the row named the other tenant's place as well, so Postgres refused on
the location key first. Naming the tenant's own place isolates the claim.

Two wrong greens in one test. Both were found by running probes rather than by
reading it.

### `FORCE` cannot be observed from the application identity

Probing `NO FORCE ROW LEVEL SECURITY` broke nothing in this feature's tests, and
that is correct rather than a gap: `FORCE` only affects the table **owner**, and
`cubeforge_app` is not the owner. What guards it is the existing policy-coverage
test, which reads `pg_class` directly. Both `NO FORCE` and `DISABLE ROW LEVEL
SECURITY` fail it.

The probe that appeared to find nothing was measuring the wrong identity.

### Append-only is two absences, on purpose

No `UPDATE` or `DELETE` grant on `stock_movements`, **and** no policy that would
permit either. Stated twice so restoring one by accident is not enough. Probes F
and G restore the grant *and* add a matching policy, and both tests bite.

### `resetDatabase` names its tables by hand

It does, with a comment explaining that forgetting one fails visibly later. All
three new tables were added to it. Truncation order matters: movements first,
then the two reference tables.
