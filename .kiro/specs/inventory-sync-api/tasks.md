# Implementation Tasks — inventory-sync-api

Ordering follows Foundation → Core → Integration → Validation. Task N implicitly
depends on everything before it; `_Depends:_` marks only non-obvious or
cross-group dependencies. `(P)` marks tasks safe to run concurrently with their
immediate peers.

## 1. The ground everything else stands on

The tables and the rules the database itself enforces. These two are one
checkpoint rather than two: the platform's policy-coverage test turns red the
moment a table exists without a policy, so 1.1 alone leaves the suite failing.

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

## 2. What a movement is, decided without a database

Pure rules, testable without a container. This is where the properties the
project exists to demonstrate stop being framework behaviour.

- [x] 2.1 Name the things a tenant refers to
  - Distinct identifier types for a SKU, a place code and a source-system
    movement identifier, so one cannot be passed where another is meant
  - Refuse an empty identifier, one longer than permitted, and one carrying
    characters outside the permitted set, naming which rule refused it
  - Done when each constructor rejects every malformed shape with the reason
    named, and the compiler refuses a SKU used as a place code
  - _Requirements: 1.4_
  - _Boundary: Inventory domain_

- [x] 2.2 Judge a movement on its own terms
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

- [x] 2.3 Declare what persistence must offer, without providing it yet
  - Three port interfaces: one shape shared by the catalogue and the places —
    declare, replace, answer which of a set exist — and one for movements,
    covering the insert that skips what is already recorded and the sum
  - Interfaces only. They compile against nothing and are consumed by nothing
    yet, which is what lets the two repository tasks that follow run alongside
    each other without editing one file
  - Express membership questions as a set of codes rather than as rows: it is
    the only question asked before an insert, and returning records nobody
    reads is an invitation to read them
  - Done when the three interfaces typecheck, reference the identifier types
    from 2.1, and no implementation of any of them exists
  - _Requirements: 7.2_
  - _Depends: 2.1_
  - _Boundary: Application ports_

## 3. The things movements point at

Two entities of one shape. The interface is shared; the implementations stay
two small concrete repositories rather than a base class.

- [x] 3.1 (P) Keep a tenant's product catalogue
  - Declaring a product that is not present records it; declaring one that is
    replaces its describable attributes, and the caller is told which happened
  - Answer which of a set of SKUs are declared, returning membership rather than
    rows, because that is the only question asked before an insert and returning
    records nobody reads is an invitation to read them
  - Offer no way to delete: movements already recorded point at it, and the
    history has to stay readable
  - Provide both the real implementation and the in-memory one used by tests
  - Touch no shared file: the seam is widened once, by 4.2, for all three
  - Done when re-declaring reports an update rather than a second product, two
    tenants hold the same SKU independently, and no deletion path exists
  - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - _Depends: 2.3_
  - _Boundary: ProductRepository_

- [x] 3.2 (P) Keep a tenant's places
  - The same shape as the catalogue: declare, replace, answer membership, never
    delete
  - Done when re-declaring reports an update, and the membership answer is what
    a later movement check consumes
  - _Requirements: 2.1, 2.2, 2.4_
  - _Depends: 2.3_
  - _Boundary: LocationRepository_

## 4. Recording what happened

- [x] 4.1 Record movements without racing a retry
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

- [x] 4.2 Widen the tenant-scoped seam to carry inventory
  - Add the three repositories to the set handed to work running inside a
    tenant, in both the real and the in-memory implementations
  - An explicit integration task because it is the one place three boundaries
    meet. It cannot come earlier: the seam constructs concrete repositories, so
    widening it before they exist does not compile. It cannot come later: no use
    case can reach persistence until it does
  - Introduce no second way to reach persistence — the existing seam hands
    repositories to a callback precisely so there is no construction path that
    skips the tenant, and a second path would be worth exactly as much as the
    number of ways around the first
  - Done when a use case can obtain all three inside a tenant and cannot obtain
    any of them outside one, and the existing suite still passes
  - _Requirements: 7.2_
  - _Depends: 3.1, 3.2, 4.1_
  - _Boundary: TenantScopedUnitOfWork_

- [x] 4.3 (P) Declare a product and a place
  - Two use cases over the repositories from section 3: recording what is not
    there, replacing what is, and telling the caller which happened
  - Done when re-declaring reports an update rather than an error, and neither
    use case can be constructed with a repository obtained outside a tenant
  - _Requirements: 1.1, 1.2, 2.1, 2.2_
  - _Depends: 4.2_
  - _Boundary: declareProduct, declareLocation use cases_

- [x] 4.4 Turn a batch into an answer about every row
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
  - _Depends: 4.2_
  - _Boundary: recordMovements use case_

- [x] 4.5 (P) Answer what is on hand
  - Sum the movements recorded for the tenant, per product and place
  - Report a pairing whose movements cancel out as zero rather than omitting it
  - Permit a negative result, and refuse no sale for taking stock below zero:
    the platform records what a source system reports, and deciding what is
    possible in that system's warehouse is not its job
  - Done when a product received and then sold in equal quantity appears with
    zero, and a sale exceeding what arrived is recorded and reported negative
  - _Requirements: 6.1, 6.2, 6.3_
  - _Depends: 4.2_
  - _Boundary: MovementRepository, readStockOnHand use case_

## 5. Reaching it over HTTP

- [x] 5.1 (P) Expose the catalogue and the places
  - A route to declare each and a route to list each
  - Declare who may reach them: writing needs an administrator or an editor,
    reading admits a viewer, and **all of them admit a machine credential** —
    these are the first routes on the platform to say so
  - Keep these payload shapes in their own file, apart from the movement
    payloads, so this task and 5.2 do not edit one file concurrently
  - Done when every route carries an explicit declaration and the existing
    declaration-drift check still passes
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 7.3, 7.4_
  - _Depends: 4.3_
  - _Boundary: HTTP inventory controllers_

- [x] 5.2 Expose recording, one and many
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
  - _Depends: 4.4_
  - _Boundary: HTTP inventory controllers_

- [x] 5.3 (P) Expose stock on hand
  - One read route, admitting a viewer and a machine credential
  - Done when a viewer's credential can read it and cannot write anything
  - _Requirements: 6.1, 7.4_
  - _Depends: 4.5_
  - _Boundary: HTTP inventory controllers_

- [x] 5.4 (P) Slow a caller synchronising too eagerly
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

- [x] 5.5 Wire the feature into the running application
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

- [x] 6.1 Travel the machine path for the first time
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

### The task graph had a cycle, found at 1.3

1.3 was *widen the tenant-scoped seam*. The seam **constructs** concrete
repositories, so widening it before they exist does not compile — and the
repositories cannot be reached by any use case until it is widened. It also
needed the identifier types, which were 2.1.

Reordered rather than worked around: the ports are declared in 2.3 (interfaces,
consumed by nothing), the repositories are built in 3.1, 3.2 and 4.1 touching no
shared file, and the widening became **4.2**, an explicit integration task —
which is what the design's own rule asks for when work crosses boundaries. The
use cases follow it.

The sanity review missed this because it checked whether tasks could run
*concurrently*, not whether each could compile *alone*.

### Codes are refused, never repaired

`parse` does not trim and does not case-fold. Normalizing would mean
` ACME-001` and `ACME-001` are one product on the path that normalizes and two
on the path that forgot; refusing is the only answer that cannot be
inconsistent. It is the same reason places are a declared resource rather than
free text.

A probe adding a trim *after* the character check changed nothing, because the
value was already refused by then — the probe was defeated by a second
mechanism. Moving the trim *before* the checks is the one that bites, and it
does.

### One reason per row, not a list

`judgeMovement` reports the first thing wrong and stops. A caller fixes one
thing and resubmits, and the report this feeds carries up to five hundred
entries.

### Every rule was removed on its own

Seven rules, seven probes, each removing exactly one and each turning a
different test red. `occurred-not-a-moment` was not in the design's list of
reasons; an invalid `Date` is reachable from a payload, so it was added and the
design updated to match.

### A port that was already speculative when written

`MovementRepository` was drafted with a `list()` "for the export feature". It
serves nothing here, and every implementation would have had to write it for
nothing. Removed — it is the exact abstraction the design's own simplification
rule exists to prevent, and writing the justification into a doc comment did
not make it less so.

### `xmax = 0` reports which half of an upsert happened

Declaring is one statement, because a read followed by a write is a race two
synchronisations declaring the same product would both lose. A single upsert
cannot normally say whether it inserted or replaced; `xmax` is zero on a row the
statement inserted and non-zero on one it updated, which recovers the answer
without a second query. Probe A makes it always claim `created` and the test
bites.

### The tenant predicate needed its own suite to be testable at all

Dropping the `where` clause from the Postgres repository changed **nothing**
observable — row-level security still held. That is the two-layer design working
exactly as intended, and it is also why the platform already has a
`first-isolation-layer` suite that connects as a superuser, whom policies do not
apply to.

These repositories cannot join that suite until the unit of work carries them
(4.2), so the same claim is made locally for now. With it, the probe bites.

**A predicate with a policy behind it is untested by every ordinary test.**

### Two `useIntegrationDatabase` blocks in one file share a teardown

The second block captured a connection pool at module load, and the first
block's teardown had already closed it. Asked for per call instead. Worth
knowing before the remaining integration specs are written.

### The concurrency test was theatre, twice

This is the central claim of the feature — recording is one statement so two
retries cannot both insert — and the test asserting it was wrong in two
different ways before it worked.

**First:** it asserted "no duplicates, and the stock is right". A read-then-write
implementation satisfies both, because the unique constraint kills the losing
transaction with an error. The probe passed. The constraint was doing the work
while the transaction died to make it happen, which is the wrong green.

The property that actually separates the two is that **both submissions
succeed**. `on conflict do nothing` waits for the other transaction and then
skips; reading first aborts. A caller retrying a timed-out batch must get an
answer, not an error about a movement it already sent.

**Second:** with that tightened, the probe *still* passed — because the test was
not concurrent. `Promise.allSettled` starts two promises; the scheduler is free
to run the first to completion before the second begins, and then the second
finds the rows already there and reports honestly. It overlapped by luck, and
the luck went the wrong way.

Now the first transaction is held open and the test **asks the database** —
polling `pg_stat_activity` for a statement waiting on a lock — before committing
it. A fixed delay would have made the overlap a guess about how fast this
machine is. With that, the probe bites.

**Two independent reasons a test can be green while proving nothing, in one
test.** Neither was visible by reading it.

### The tenant predicate, again

Same as the catalogue: dropping the `where` from the sum changed nothing, RLS
held, and the claim needed its own policy-bypassed block before the probe would
bite.

### And another speculative export

`STOCK_ON_HAND_IS_DERIVED` — a `sql` fragment exported "beside the query it
explains", used by nothing. Deleted. Second time this feature; the reflex is
apparently to leave a landmark next to anything interesting.

### The local isolation blocks were temporary, and were removed

3.1 and 4.1 each carried their own policy-bypassed block, because the claim had
nowhere else to live until the seam carried these repositories. It does now, so
inventory joined `first-isolation-layer.integration-spec.ts` and the two local
blocks were deleted rather than left as a second copy.

That suite is the better home for a reason worth stating: it answers "does the
application scope its own reads" for **every** tenant-owned table in one place,
so a table added later without a predicate is a gap somebody notices. Both
probes — dropping the product predicate, dropping the movement sum's predicate —
bite from there.

### Rolling back one store is rolling back none

The in-memory seam restores a snapshot when work rejects, so a use case that
refuses a request leaves nothing behind. Inventory is a **second** store, and
restoring only the first would let exactly that bug through. Both are named, and
the probe removing the inventory half bites.

The real adapter gets this for free — one transaction, one rollback — which is
precisely why the double has to be told.

### The seam takes the inventory store with a default

Every existing caller builds it with two stores. A third parameter without a
default would have been a mechanical edit across files this task has no business
touching; a real store rather than an optional one means a use case reaching for
`movements` in a context that forgot to pass one fails on what it did rather
than on `undefined`.

### The platform had no way to ask a machine which tenant it is in

`tenantOf` refuses a machine on purpose — every surface before this one was
built for people. Inventory is the first built for machines, so it needed the
question asked differently.

Added `tenantActedIn` as a **sibling** rather than widening `tenantOf`. The
justification written into the first draft of that comment was wrong, and the
probe is what showed it: widening `tenantOf` would not have let machines reach
any existing route, because the guard refuses a key on any route that does not
declare `machines` **and** those use cases resolve a membership a key does not
have. Both refusals stand without it.

What widening would actually do is delete one redundant refusal for no gain, and
put two questions inside one name. `tenantOf` means "the tenant this person is a
member of"; `tenantActedIn` means "the tenant this caller acts in, whoever they
are". Those are different questions and inventory needs the second.

**The probe disproved the premise of the claim it was written to confirm.** The
decision survived; the reasoning did not, and the comment now says the true
thing.

### A check behind another check is untested, again

Nothing in either suite noticed `tenantOf` being widened — the guard and the
membership lookup both answer first. Same shape as a repository predicate behind
a row-level security policy, and as `FORCE` being invisible to a non-owner.
Three instances now, and the rule is worth stating plainly:

**A refusal with another refusal in front of it is proven by nothing until it is
asserted directly.**

`tenant-authorization.spec.ts` asserts both helpers against all four kinds of
caller. With it, the probe bites.

### The command carries no tenant

Neither `DeclareProductCommand` nor `DeclareLocationCommand` has a tenant field.
"A caller in Acme declaring into Globex" is not refused — it is not expressible.

### The use case parses; the edge does not

`SubmittedRow` carries strings, and the identifiers are parsed inside the use
case rather than at the controller. That is the whole reason a per-row report is
possible: a constructor throwing at the edge makes one malformed code the
*request's* failure, and this feature's entire premise is that it is one row's.

It is also why `parse*` exists beside the throwing constructors. The two forms
are not redundant — they serve callers with and without a per-row answer to
give.

### The report is positional, and that is load-bearing

A caller correlates outcomes to submitted rows by index, so the report must have
exactly one entry per row, in order. `summarise` throws if any row is missing an
outcome rather than returning a shorter list, because a shorter list does not
fail — it silently describes the wrong movements from the gap onwards.

Two probes: grouping the report by status, and dropping one row's outcome. Both
bite.

### A duplicate in one batch is not a retry

Both mean "I have seen this identifier before", and they are told apart on
purpose. A caller retrying a request is expected and answered
`already-recorded`; a caller that put one document into a batch twice has a bug
in how it batches, and giving it the reassuring answer would hide that bug
forever.

### Five stages, five probes

Duplicate detection, replay reporting, reference checking, the standalone
invariants, and judging against the clock rather than a constant. Each removed
on its own, each turning a different test red.

### Zero is a fact, and negative is somebody else's business

Two rules that look like edge cases and are not.

**A pairing summing to zero is reported, not omitted.** Omitting it would make
"we sold everything we had" indistinguishable from "we never stocked it", which
are opposite facts about a warehouse.

**A total may go below zero, and a sale taking it there is not refused.** The
platform records what a source system reports; deciding what is possible in that
system's warehouse is not its job, and refusing would mean quietly disagreeing
with the books it mirrors. If the ERP thinks it sold nine and received two, the
honest answer is minus seven and a conversation for somebody else.

### No caching, deliberately

Summing is the right answer at this scale, and pre-aggregation is exactly what
the semantic layer of a later feature exists to do. Building it here would build
that feature twice, in the place with the least information about how the
numbers are actually asked for.

### The open question is now visible in a test

A declared product that never moved yields no row, because stock is grouped over
movements and such a product has no place to be counted at. It was open question
1 in the design; it is now a test that says so, so a dashboard wanting the
catalogue with zeroes finds the decision rather than the surprise.

## Section 4 complete — the application layer answers everything

Sections 1 through 4 are done. Every requirement about *behaviour* is now
satisfied and tested without HTTP: declaring, recording, replaying, batching,
summing, and refusing a caller who acts in no tenant. What remains is reaching
it (section 5) and proving the properties end to end (section 6).

### The design put the routes where no machine could reach them

`/inventory/products` — and the guard already had the answer written into it:

> A route that admits machines and names no tenant has nothing to compare a key
> against, and returning `null` refuses it.

A person's tenant is read from the path; a machine's comes from its key, and
the guard confines the key by comparing the two. With no tenant in the path
there is nothing to compare, so **every machine caller would have been refused**
— on the surface built for machines, with a refusal indistinguishable from an
absent record.

Routes are now `/tenants/:tenantId/inventory/…`, the design's table is
corrected, and a new route-inventory test refuses any machine route whose path
names no tenant. The next feature to admit a key cannot repeat this.

### The use cases were not enforcing roles at all

Caught by `declaration-drift.spec.ts`, which pairs every route's declared roles
with a constant its use case exports and actually applies. Inventory had no such
constants, because these use cases leaned entirely on the guard — a **single**
layer, on a platform whose whole authorization story is two.

Fixed properly rather than by exempting the routes: six `*_ROLES` constants, and
`authorizeCallerInTenant` beside `authorizeInTenant`. The new one exists because
a machine has **no membership to resolve** — its role is carried by its
credential — but the tenant still has to be checked, or a key issued into a
tenant that was later deactivated would keep working. The membership path
already refuses that for people.

Probe D removes the second layer: two tests bite, including the deactivated
tenant.

### The tests were passing without a tenant existing

Rewriting them on the real test context turned 32 green tests red. Every
application-tier inventory test had been using actors naming tenants that were
never provisioned, and passing — because nothing resolved a tenant or a role
until now. They were not testing authorization; they were testing that
authorization was absent.

### A test that asserted the empty set now names its members

`route-inventory.spec.ts` said *"admits no machine caller on any route it ships
with"*, with a comment: *"no real endpoint uses it until feature 5 decides one
should."* This is feature 5. The assertion was rewritten to list the four routes
rather than deleted, so the next one is added by editing that line rather than
by nobody noticing.

### The drift check compared whole declarations

It asserted `declaration === { roles }`, which no machine route can satisfy.
Split: the roles are still compared exactly — that is the drift it exists to
catch — and the permitted key set is asserted separately, so `machines` does not
become a hole through which anything else could arrive.

Five probes: widening the route, narrowing it, widening only the use case,
removing the second layer, and moving the route out from under the tenant. All
five bite.

### The edge validates shape; it must not validate meaning

`MovementRow` carries no `@IsIn` on `kind`, no sign rule, no past-tense check on
`occurredAt`. Every one of those is a per-row rejection with a named reason, and
enforcing it at the edge turns one bad row into the whole request's failure —
the single thing this feature exists not to do.

Probe B adds `@IsIn(['receipt','sale','adjustment'])` to the DTO, which looks
like tightening and is the opposite: the row that should have come back
`unknown-kind` in a report becomes a 400 for the batch. It bites.

What the edge does enforce is what cannot be a row's problem: a field of the
wrong *type* means the payload was not what it claimed to be, and a batch over
five hundred means the request was too big. Both are the request's failure, and
both go through the error filter.

### Both routes answer 200, including when a row was refused

A partially applied batch is not a failure. 207 would say "inspect the body",
which is true of every response here including the clean one, so it would carry
no information.

Asserted end to end: a batch with two bad rows answers **200** with the
rejections in it. A caller who only reads the status sees success — which is why
the report can never be shorter than what was sent, and why probe D (dropping
rejected rows from the response) bites.

### A test that tolerated two opposite answers

One draft asserted `expect([200, 404]).toContain(stock.status)` against a route
task 5.3 had not built yet. A test that passes whether the route exists or not
proves nothing about either. Replaced with the fact actually being claimed:
nothing from the refused batch was written, shown by resubmitting one of its
rows and getting `recorded`.

### `reflect-metadata` is loaded by Nest, not by the DTO

`class-transformer`'s `@Type` calls `Reflect.getMetadata` while the module is
evaluated. In the application Nest has already loaded the shim; a test importing
the DTO module directly has not. The spec imports it first, with a comment
saying why — the alternative was an import in every DTO to serve one caller.

### `ThrottlerModule` is `@Global`, and a second `forRoot` replaces rather than adds

Registering the inventory buckets in `InventoryModule` would have **deleted the
credential limits** — sign-in throttling, the thing that stops password
guessing — and nothing would have failed. The module is decorated `@Global` in
the library, which the comment in `AuthenticationModule` did not know: it said
*"registered here rather than globally"*, which was never true.

Moved to the composition root, one registration holding every bucket. Each
throttled handler now skips the buckets that are not its own, in both
directions, because a global bucket applies to every throttled handler by
default — an inventory route would otherwise be counted by `sign-in-address`,
whose tracker reads an email out of a body it does not have.

### The stock allowance was sixty per *route*

`ThrottlerGuard.generateKey` includes the controller and the handler, so a
caller got sixty reads **and** sixty writes **and** sixty batches — four hundred
and twenty a minute against a limit that says sixty. Nothing about the
configuration looked wrong.

Found by the test that exhausts the allowance with reads and then writes
successfully. `generateKey` is overridden to the bucket and the tracker alone.

### `Retry-After-inventory-credential` is not a header anyone honours

For a *named* bucket the library suffixes the header with the bucket's name. No
HTTP client, proxy or retry library reads that — a caller would have to know
this platform's internal bucket names to find the wait. The plain `Retry-After`
is set alongside it.

### A test that compared two tenants to prove something about credentials

The first draft of "counts a second credential separately" seeded a **second
tenant**. Two tenants differ in both respects at once, so it could not tell
per-credential from per-tenant apart — and the probe that switched the tracker
to the tenant passed. Rewritten with two members of one tenant; the probe now
bites.

### A probe that could not be run

Raising the allowance to a hundred thousand made the exhausting loop take longer
than the timeout. The probe was unrunnable rather than uninformative — worth
recording so it is not mistaken for a gap. The limit's effect is covered by the
other four.

### The machine path works, and it was worth travelling to find out

Every inventory route reached with a real API key: an editor key writes and
reads, a viewer key reads and is refused every write, a key presented against
another tenant's inventory gains nothing, a revoked key gains nothing, and a
caller with no credential is refused on all seven.

All seven passed first time, which is not evidence — probes are. Removing
`machines: true` from one route turns two tests red; removing the guard's
tenant confinement turns the trespass test red.

### The second authorization layer is invisible from HTTP, necessarily

Widening a use case's roles to admit a viewer leaves **every** assertion in the
machine suite green: the guard refuses the key at the edge, so the use case
never runs. The application-tier suite turns red instead, which is where that
claim belongs.

Third instance of the same shape — a repository predicate behind a policy,
`tenantOf` behind the guard, and now this. The rule has held every time:
**whichever layer answers first hides the other, so each has to be asserted
where nothing stands in front of it.**

Written into the test rather than left for the next reader to rediscover.

### A missing controller is a missing route, and that fails nothing by itself

Every other route test compares what the application serves against what it
declares — and a controller left out of its module is absent from both sides.
`route-inventory.spec.ts` now names the seven inventory routes explicitly, so
dropping one from the module fails by name. Both probes bite.
