# Research — inventory-sync-api

**Discovery type:** light. This is an extension: the platform already has a
tenant-scoped write path, an access declaration model, row-level security and a
throttling guard. The open questions are about fitting inventory into those
seams, not about inventing them.

**Scope of discovery:** existing ports and unit-of-work contracts, the access
declaration model, the row-level security pattern, the throttling adapter, and
how partial success can be expressed without giving up idempotency.

## Investigations

### 1. Is there already a tenant-scoped write seam, or does this feature need one?

`src/application/ports/tenant-scoped-unit-of-work.ts` defines
`runInTenant(tenantId, work)`, handing repositories to a callback rather than
injecting them. Its own comment states the reason:

> Repositories are handed to the callback rather than injected, so there is no
> construction path that skips the tenant.

**Implication:** inventory repositories join `TenantScopedRepositories`. This
feature adds no second unit of work. A new unit of work would be a second
construction path, and the guarantee above is worth exactly as much as the
number of ways around it.

### 2. Can an API key already reach a tenant-scoped route?

Yes, and nothing uses it. `AccessDeclaration` in
`src/adapters/http/access/access.decorator.ts` carries:

> `machines` additionally admits an API key carrying one of them; **no shipped
> route sets it**, and the guard confines an admitted key to its own tenant.

**Implication:** `inventory-sync-api` is the first consumer of a path that was
designed, built, tested and never exercised. That is a risk worth naming — an
untravelled path is an untested one regardless of its unit tests — and it is
also the reason this feature needs no new authorization mechanism.

### 3. How does the platform express "some of this worked"?

It does not. Every mutating endpoint so far is one act by one person, mapped
through `domain-error.filter.ts` to a single status: a tagged `kind` becomes
one HTTP response, with the switch deliberately exhaustive so an unhandled kind
fails the build.

**Implication:** partial batch acceptance is genuinely new. It cannot be
expressed as a thrown domain error, because a thrown error is the whole
response. The batch outcome has to be a *value the use case returns* — a report
naming each submitted row's fate — and the filter stays out of it. The filter
keeps its job: whole-request failures, such as a batch that exceeds the size
limit (requirement 4.3), which is why 4.3 refuses the batch as a whole rather
than reporting 500 individual rejections.

### 4. Can replay detection and partial acceptance share one mechanism?

They can, and the database does both in one statement. An insert of the
surviving rows carrying `ON CONFLICT (tenant_id, external_id) DO NOTHING` with
`RETURNING` reports back exactly the rows that were newly recorded; the
submitted rows absent from that result are the ones already present.

**Implication:** no read-then-write. Checking for existing identifiers first and
inserting second is a race that two concurrent retries of the same batch will
eventually lose, producing the duplicate the whole requirement exists to
prevent. The unique constraint is the mechanism and the query merely observes
its outcome.

**Not covered by it:** two rows carrying the same identifier *inside one batch*
(requirement 4.4). That is a different question — a client that batched the
same document twice has a bug, and it is reported as a rejection, not as a
successful replay. Detected in the application layer before the insert.

### 5. Does the reference check need a lock?

Requirements 1.5 and 2.4 forbid deleting a product or a location. Therefore a
reference validated at the start of a request cannot stop being valid before
the insert, and the check needs no lock and no re-check.

**Implication:** the prohibition on deletion, written into requirements for the
sake of readable history, also removes an entire class of concurrency problem.
Worth recording, because a later change permitting deletion would silently
reintroduce it. Listed under revalidation triggers.

### 6. Rate limiting: build or adopt?

`@nestjs/throttler` ^6.5.0 is already a dependency, and
`CredentialThrottlerGuard` already extends `ThrottlerGuard` with a custom key
and a cooldown distinct from its window.

**Decision: adopt.** A second throttler guard keyed on the credential rather
than the network origin, with its own configuration object following
`throttling.config.ts`. Building a limiter would be building the one thing in
this feature that is thoroughly solved.

**Storage caveat:** the default storage is in-process. On one instance that is
correct; across the serverless deployment of a later feature it is not, and the
allowance becomes per-instance. Recorded as a risk rather than solved here,
because there is no second instance until the deployment feature exists, and a
shared store introduced now would be infrastructure serving a hypothetical.

### 7. What does a movement's `occurredAt` mean for the analytical pipeline?

Nothing in this feature, and a great deal in step 6. An export partitioned by
the moment a movement occurred has to rewrite a partition whenever a backdated
movement lands in it; one partitioned by the moment it was *recorded* never
does, because recording only ever moves forward.

**Implication:** both timestamps are stored. `occurredAt` is the business fact
and answers "when did this happen"; `recordedAt` is monotonic and is what a
later incremental export will key on. Storing only the first would force the
export feature to add a column to a table that by then has history in it.

## Synthesis

### Generalization

Products and locations are the same shape: a tenant-owned reference entity with
an identifier the tenant chooses, declared idempotently, never deleted, and
referenced by movements. They are designed against one repository contract
parameterised by the entity, not two contracts that happen to match. The
implementation stays two small concrete repositories — the generalization is in
the shape of the interface, not in a shared base class.

Movements are deliberately *not* generalized with them. They are append-only,
high-volume and never updated, which is a different lifecycle with different
indexes and a different policy.

### Build vs adopt

- **Rate limiting** — adopt `@nestjs/throttler`, already present (investigation 6).
- **Idempotency** — adopt the database's unique constraint rather than an
  application-level registry of seen identifiers (investigation 4). A registry
  would be a second source of truth for a question the constraint answers.
- **Tenant isolation** — adopt, entirely. Row-level security plus the existing
  unit of work. This feature adds tables and policies, not a mechanism.
- **Batch outcome reporting** — build. There is no established contract in this
  codebase for it, and no external standard worth adopting for a shape this
  small.

### Simplification

- **No new unit of work** (investigation 1).
- **No inventory service layer.** Use cases are the layer; a service between
  controller and use case would be a pass-through.
- **No separate port for the stock query.** It is a method on the movement
  repository. It needs a port at all only because the in-memory adapter is a
  real second implementation; it does not need a port of its own, and a
  `StockReadModel` token alongside `MovementRepository` would be the uniform
  indirection steering warns reads as architecture for its own sake.
- **No caching of stock on hand.** Summing movements is the correct answer at
  this feature's scale, and pre-aggregation is precisely what step 8's semantic
  layer exists to do. Adding it here would build that feature twice.

## Risks

1. **The `machines` path is untravelled** (investigation 2). Mitigated by
   integration tests that exercise every inventory route with a real API key,
   not only with a person's token.
2. **Throttler storage is per-instance** (investigation 6). Accepted for now;
   revalidate at the deployment feature.
3. **Stock on hand is an unbounded aggregate.** A tenant with millions of
   movements makes it slow. Accepted: it is bounded by the demo seed today, and
   step 8 replaces the access path.
4. **Partial success is easy for a client to ignore.** A caller treating a
   successful response as "all rows landed" loses data silently. Mitigated by
   never reporting a partially applied batch with the same outcome as a fully
   applied one.

## Revalidation triggers

- Permitting deletion of a product or location — reintroduces the concurrency
  problem investigation 5 removed.
- Permitting a movement to be amended — breaks the append-only assumption the
  export feature will depend on, and invalidates `recordedAt` as an incremental
  key.
- Running more than one API instance — makes the rate-limit allowance
  per-instance.
- Adding a movement kind that references two locations — 3.8 exists to keep
  that out; admitting it changes the row shape.
