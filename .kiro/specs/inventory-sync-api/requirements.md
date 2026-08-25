# Requirements — inventory-sync-api

## Project Description (Input)

### Who has the problem

- **Machine callers** — an upstream ERP, warehouse system or point-of-sale
  pushing what happened to stock. Steering already names them a first-class
  audience and says the API "must tolerate" their retries. Today there is
  nothing for them to call. They authenticate with an API key, and then find no
  endpoint that accepts data.
- **Every feature after this one.** The roadmap's steps 6 through 9 export
  historical data to columnar storage, query it from a separate engine, define
  metrics over it and chart them. All four assume a body of transactional data
  that no part of the platform currently produces. This is the feature that
  gives the pipeline something to move.
- **The reviewer.** The platform can today prove that a caller is who they say,
  and that they may not read another tenant's rows. It cannot yet show either
  property applied to a real write path under load and retry, which is where
  both are actually hard.

### Current situation

The platform provisions tenants, people and memberships; authenticates
dashboard users with JWTs and machine callers with API keys; and enforces role
and tenant scoping as infrastructure rather than per route. Postgres runs with
`ENABLE` plus `FORCE` row-level security under four separate database
identities.

What none of that has yet met is a **write path a client is expected to
retry**. Every mutating endpoint so far is driven by a human pressing a button
once. Steering states the standard plainly — "replaying any mutating request
produces no duplicate effects" — and no feature has had to honour it against a
caller that retries by design, in batches, on a schedule.

There is also no business data. The database holds identity and access, and
nothing a metric could be computed from.

### What should change

A tenant-scoped inventory surface that an upstream system can synchronise
against, authenticated by API key: a product catalogue and a set of locations
that change rarely, and an append-only stream of stock movements that does not.
Stock on hand is derived by summing movements, never stored as a mutable
number.

## Decisions taken before drafting

Four questions the description left open, and the answers this document is
written against. Each is recorded with its reason, because each has a cheaper
alternative that was rejected for a specific cost.

1. **A batch is applied partially, and reports per row.** Rejecting five
   hundred rows because three are wrong means one mistyped SKU stops the whole
   synchronisation, and in a nightly integration that is discovered days later.
   The cost accepted: "succeeded" stops being a yes-or-no answer, and a caller
   that ignores the response body will silently lose rows.
2. **Replay is recognised by an identifier the source system supplies for each
   movement**, not by a key covering the request. With partial batches a retry
   carrying three corrected rows is a different request, so a request-level key
   would protect nothing. The row is the granularity that matters, and the
   upstream system already has that identifier — it is its own document number.
3. **Locations are declared before use, exactly like products.** `WH-1`, `WH1`
   and `wh-1` as free text are three warehouses to an analytical engine, and
   that error surfaces months later as a chart that sums wrongly. Treating
   products and locations by one rule also removes the question of why one is
   validated and the other is not.
4. **A movement is never edited or deleted; a mistake is offset by another
   movement.** Append-only with an exception for editing is not append-only,
   and that exception is precisely the one that breaks incremental export to
   columnar storage — an already-exported row that changes forces partitions to
   be rewritten. The history stays auditable: the error remains visible next to
   its correction.

## Requirements

### 1. Product catalogue

**User story:** As a machine caller, I want to declare the products my tenant
tracks, so that movements can reference them by the SKU my own system already
uses.

#### Acceptance criteria

1.1 When a caller declares a product with a SKU not yet present in its tenant,
the Inventory Sync API shall record the product and report it as created.

1.2 When a caller declares a product with a SKU already present in its tenant,
the Inventory Sync API shall replace the product's descriptive attributes and
report it as updated.

1.3 The Inventory Sync API shall treat a SKU as unique within a tenant and
meaningless across tenants, so that two tenants may each use the SKU
`ACME-001` for unrelated products.

1.4 If a caller declares a product whose SKU is empty, longer than the
permitted length, or contains characters outside the permitted set, the
Inventory Sync API shall reject the declaration and name the offending field.

1.5 The Inventory Sync API shall not provide a way to delete a product,
because movements already recorded reference it and the history must remain
readable.

### 2. Locations

**User story:** As a machine caller, I want to declare the places stock can be,
so that a movement records where it happened and a typo cannot invent a
warehouse.

#### Acceptance criteria

2.1 When a caller declares a location with an identifier not yet present in its
tenant, the Inventory Sync API shall record the location and report it as
created.

2.2 When a caller declares a location with an identifier already present in its
tenant, the Inventory Sync API shall replace its descriptive attributes and
report it as updated.

2.3 If a caller submits a movement naming a location that has not been
declared in its tenant, the Inventory Sync API shall reject that movement and
report the reason as an unknown location.

2.4 The Inventory Sync API shall not provide a way to delete a location, for
the reason given in 1.5.

### 3. Stock movements

**User story:** As a machine caller, I want to record what happened to stock,
so that the platform holds the history rather than a number that overwrites
itself.

#### Acceptance criteria

3.1 When a caller submits a movement naming a declared product and a declared
location, with a non-zero whole quantity, a kind, an identifier from the source
system and the moment it occurred, the Inventory Sync API shall record it and
report it as accepted.

3.2 The Inventory Sync API shall accept the kinds `receipt`, `sale` and
`adjustment`, and shall reject any other kind.

3.3 The Inventory Sync API shall require a `receipt` to carry a positive
quantity and a `sale` to carry a negative quantity, and shall permit an
`adjustment` to carry either.

3.4 If a caller submits a movement whose quantity is zero, fractional, or
outside the permitted magnitude, the Inventory Sync API shall reject that
movement and name the quantity as the reason.

3.5 If a caller submits a movement whose moment of occurrence lies in the
future, the Inventory Sync API shall reject it, and where that moment lies in
the past the API shall accept it, so that a nightly synchronisation can report
yesterday's activity.

3.6 The Inventory Sync API shall not provide a way to amend or delete a
recorded movement.

3.7 When a caller submits a movement that offsets an earlier one, the Inventory
Sync API shall record it as an ordinary movement and shall retain both.

3.8 Where stock moves between two locations, the Inventory Sync API shall offer
no single operation that does both, so that the movement is expressed as one
leaving the source and one arriving at the destination.

### 4. Batch submission

**User story:** As a machine caller synchronising nightly, I want to send many
movements in one request and be told exactly which ones did not take, so that
one bad row does not cost me the whole night's data.

#### Acceptance criteria

4.1 When a caller submits a batch of movements, the Inventory Sync API shall
record every movement that satisfies Requirement 3 and reject only those that
do not.

4.2 When a batch is partially applied, the Inventory Sync API shall report the
number accepted and, for each rejected movement, its position in the submitted
batch and the reason it was rejected.

4.3 The Inventory Sync API shall accept at most 500 movements in one batch, and
if a caller submits more it shall reject the batch as a whole without recording
any of it, so that the caller cannot mistake a size refusal for a data error.

4.4 If a batch contains two movements carrying the same source-system
identifier, the Inventory Sync API shall record the first and reject the second
as a duplicate.

4.5 The Inventory Sync API shall offer a single-movement submission alongside
the batch, reporting acceptance or a single reason for rejection.

### 5. Replay

**User story:** As a machine caller whose request timed out, I want to send the
same movements again, so that I can retry safely without knowing whether the
first attempt arrived.

#### Acceptance criteria

5.1 The Inventory Sync API shall treat the identifier supplied by the source
system as unique within a tenant.

5.2 When a caller submits a movement carrying a source-system identifier
already recorded in its tenant, the Inventory Sync API shall record no second
movement and shall report that movement as already recorded rather than as an
error.

5.3 The Inventory Sync API shall report an already-recorded movement distinctly
from a newly accepted one, so that a caller can tell a successful retry from a
successful first attempt.

5.4 When a caller re-submits a batch in which some movements were previously
recorded and others were not, the Inventory Sync API shall record only the
latter and report each movement's outcome individually.

5.5 The Inventory Sync API shall reach the same recorded state whether a given
batch is submitted once or many times.

### 6. Stock on hand

**User story:** As a caller, I want to ask what is in stock, so that I can see
the result of what I have synchronised without computing it myself.

#### Acceptance criteria

6.1 When a caller asks for stock on hand, the Inventory Sync API shall report,
per product and location, the sum of the quantities of every movement recorded
for them in the caller's tenant.

6.2 The Inventory Sync API shall report a product with movements summing to
zero as holding zero, and shall not omit it.

6.3 The Inventory Sync API shall permit stock on hand to be negative, and shall
not refuse a `sale` that would take it below zero, because the platform records
what a source system reports rather than deciding what is possible in that
system's warehouse.

### 7. Who may call

**User story:** As a tenant administrator, I want the synchronisation
credential to be able to write inventory and nothing else, so that a key stored
in an upstream system is not a key to my tenant.

#### Acceptance criteria

7.1 The Inventory Sync API shall refuse any request that carries no valid
credential.

7.2 The Inventory Sync API shall record and report inventory only within the
tenant the caller's credential belongs to.

7.3 The Inventory Sync API shall require the `admin` or `editor` role to
declare products or locations, or to submit movements.

7.4 The Inventory Sync API shall permit the `viewer` role to read stock on hand
and to read the catalogue, and shall refuse it every write.

7.5 If a caller references a product or location belonging to another tenant,
the Inventory Sync API shall answer exactly as it does for an identifier that
exists nowhere, so that a caller cannot learn that the identifier exists
elsewhere on the platform.

7.6 If a caller submits a movement carrying a source-system identifier already
recorded in a different tenant, the Inventory Sync API shall record the
movement, because uniqueness is a property within a tenant and refusing would
disclose the other tenant's contents.

### 8. Rate limiting

**User story:** As an operator, I want a caller synchronising too eagerly to be
slowed rather than to degrade the platform, so that one integration cannot cost
every other tenant its response times.

#### Acceptance criteria

8.1 The Inventory Sync API shall permit at most 60 requests per minute per
credential.

8.2 If a caller exceeds that allowance, the Inventory Sync API shall refuse
further requests until the allowance recovers, and shall tell the caller how
long to wait.

8.3 The Inventory Sync API shall count a refused request as refused and not as
recorded, so that a caller retrying after the stated wait loses nothing.

8.4 The Inventory Sync API shall apply the allowance per credential rather than
per tenant, so that one integration exhausting its allowance does not silence
another integration in the same tenant.

8.5 The Inventory Sync API shall allow a nightly synchronisation of 30,000
movements to complete within its allowance without special arrangement.

### 9. What a caller is told when something is wrong

**User story:** As an integrator debugging my synchronisation, I want a
rejection to name what was wrong, so that I can fix it without guessing.

#### Acceptance criteria

9.1 When the Inventory Sync API rejects a movement, it shall name the field or
rule responsible.

9.2 The Inventory Sync API shall report rejection reasons from a fixed,
documented set, so that a caller can act on them programmatically rather than
by matching text.

9.3 The Inventory Sync API shall not include, in any rejection, information
about records the caller may not read.

## Scope boundaries

**This feature owns:** the product catalogue, locations, the movement stream,
batch submission, replay safety, derived stock on hand, and the rate limit
applied to those endpoints.

**This feature relies on, and does not own:**

- **API key issuance and revocation**, and the roles a key carries — delivered
  by `authentication` and `tenant-and-user-management`.
- **Tenant isolation as infrastructure** — delivered by
  `rbac-authorization-guards` and by row-level security. This feature is
  expected to inherit it, and to prove it applies here, not to reimplement it.
- **The two platform-wide disclosure rules** stated in steering. Requirement 7.5
  and 7.6 restate them only where this feature creates a new way to test them.

**Explicitly out of scope:**

- **Export to columnar storage and anything analytical.** Steps 6 through 9 of
  the roadmap read this data; none of that is built here.
- **Transfers as a single operation** (see 3.8).
- **Reservations, allocations, purchase orders, costing and valuation.** This
  is a synchronisation surface for movements that already happened, not an
  inventory management product.
- **Units of measure and conversion between them.** A quantity is a whole
  number of whatever the product is counted in.
- **Webhooks, or any notification that a synchronisation completed.**
- **A user interface.** The dashboard reads this data in a later feature.
