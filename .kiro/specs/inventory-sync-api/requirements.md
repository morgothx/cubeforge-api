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
against, authenticated by API key:

- **A product catalogue**, keyed by the tenant's own SKU, changing rarely.
- **Stock movements**, append-only: a receipt, a sale, an adjustment or a
  transfer, each with a quantity, a location and the moment it occurred. Stock
  on hand is derived by summing movements, never stored as a mutable number —
  the history is the point, because the analytical layer downstream has nothing
  to analyse in a snapshot that overwrites itself.
- **Batch as the primary shape**, with a single-record endpoint alongside. A
  nightly ERP sync sends thousands of rows; one request per row is not a real
  integration, and it would turn rate limiting into a problem about the wrong
  thing. The batch has to answer the question the single endpoint never asks:
  what happens when three of five hundred rows are invalid.
- **Idempotency that survives replay**, so a caller that times out and retries
  the same batch produces the same effect once.
- **Rate limiting** that protects the transactional database from a caller
  synchronising too eagerly, without punishing a legitimate nightly load.

Inherited from steering, not restated per requirement: refusal is
indistinguishable from absence, and existing elsewhere is not observable. A SKU
that belongs to another tenant must be as invisible as one that was never
created.

### Open questions for the requirements phase

- Whether a batch is atomic or partial, and what a caller is told either way.
- Whether idempotency is keyed by a client-supplied header or by a natural key
  in the movement itself.
- Whether locations are a managed resource or a free-text field on a movement.
- Whether a movement may be corrected after the fact, or only offset by another
  movement.
