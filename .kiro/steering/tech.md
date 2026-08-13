# Technology

*Updated: 2026-08-13*

## Stack

| Concern | Choice |
|---|---|
| Language / runtime | TypeScript on Node 22 (pinned via `.nvmrc`) |
| Package manager | pnpm (pinned via `packageManager`) |
| Framework | NestJS 11 on Express |
| OLTP database | PostgreSQL 17 |
| Data access | Drizzle ORM + drizzle-kit migrations |
| OLAP engine | Amazon Athena over Parquet in S3 |
| Semantic layer | Cube.dev |
| Serverless compute | AWS Lambda + API Gateway |
| Local AWS | Floci emulator on `localhost:4566` |
| Validation | class-validator + class-transformer, at the HTTP edge |
| Tests | Jest — unit (no infrastructure) and integration (real PostgreSQL) |

## Decisions worth remembering

Each of these was a trade-off, not a default. Preserve the reasoning, because it
is the answer to "why?".

**pnpm over npm.** Blocks lifecycle scripts by default and enforces a strict
dependency graph with no phantom dependencies, which materially reduces
supply-chain attack surface. This is not a preference — it shapes how
dependencies get added. Every allowed build script is an explicit, reviewed
exception recorded in `pnpm-workspace.yaml` with a comment explaining why.

**Drizzle over TypeORM.** TypeORM's decorators live on the entity class itself,
so an `@Entity()` object is coupled to infrastructure and can no longer be a
pure domain object. Drizzle declares schema as plain TypeScript objects that
stay in the persistence adapter. This choice exists to protect the domain
boundary, so reversing it would quietly break the architecture.

**No third-party Nest/Drizzle integrator.** Wiring Drizzle into Nest is a small
first-party module and provider. Depending on a low-traffic wrapper package
contradicts the reason pnpm was chosen.

**NestJS over bare Express.** Its module system, dependency injection and Guards
map directly onto the authorization requirements. Guards in particular are why
role enforcement can be infrastructure rather than per-route code.

**Cube.dev is not serverless.** It needs a persistent pre-aggregation cache and
warm connections, which Lambda's execution model would defeat. It runs as a
long-lived service. This is the one documented exception to statelessness.

## Standards applied to every endpoint

These are the baseline, not per-endpoint judgment calls:

- **Idempotency** — any mutating endpoint that may be retried is safe to call
  more than once. Use an idempotency key where natural idempotency is impossible.
- **Rate limiting** — applied at the API layer, as both a reliability measure
  and an abuse control.
- **Explicit authorization** — every route declares its required roles via a
  Guard. Never assume a route is protected because it is undocumented, and never
  treat the frontend as a security boundary.
- **Input validation** — validate and sanitize every payload with Pipes and DTOs
  before it reaches business logic.
- **Statelessness** — no endpoint depends on in-memory state between requests.
- **Structured logging with correlation IDs** — one ID flows through the logs of
  a request end to end. Never log PII or secrets.
- **Least privilege** — tokens, keys and IAM roles scoped to exactly what they
  need.
- **HTTPS only**, including local development where feasible.

## Security posture

- **Never real AWS credentials.** Development and tests always target Floci with
  throwaway values. Assume Floci unless a human explicitly says otherwise.
- **Secrets never committed**, and never present in versioned `.env` files.
  `.env.example` documents shape, never values.
- **Two independent isolation layers.** Repository-level `tenant_id` scoping and
  PostgreSQL row-level security. They must not share a point of failure — RLS
  exists precisely for the day a use case forgets to scope. Each layer has a
  test suite that neutralizes the other, so neither can be credited for the
  other's work.
- **Three database identities, and the runtime is never the owner.** A table
  owner bypasses row-level security unless `FORCE` is set, so `cubeforge_app`
  (tenant-scoped) and `cubeforge_operator` (platform) are deliberately not the
  owner; `cubeforge_migrator` owns the schema and never serves a request. Their
  passwords are set from the environment by `pnpm db:bootstrap`, never by a
  migration, so no secret enters version control.
- **Tenant context is transaction-local.** `set_config('app.current_tenant', …,
  true)` inside the transaction, never a session-level `SET`. Connections are
  pooled; a session setting would scope the next request to the previous
  request's tenant.
- **A capability the policies cannot express becomes a `SECURITY DEFINER`
  function**, with a pinned `search_path`, granted to exactly one role, and
  returning the least it can. Two exist so far: resolving a person by email
  across the platform without granting any read, and deactivating a person the
  operator cannot see. Note that `FORCE ROW LEVEL SECURITY` applies to the owner
  too, so such a function still needs owner policies for every statement it runs.
- **A column-level `UPDATE` grant cannot target a row.** `WHERE id = …` reads a
  column, which requires `SELECT` privilege. Granting `UPDATE (status)` without
  `SELECT` permits only unqualified updates — the opposite of what is wanted.
  This is why operator-facing writes go through functions.

## Testing approach

- Unit-test the domain layer in isolation, with no infrastructure and no DI
  container.
- Integration-test adapters against Floci and a local PostgreSQL container,
  through the runtime identities, so policies apply exactly as in production.
- Drive validation suites through the **assembled application**, calling the same
  `configure()` that `main.ts` calls. A suite that builds its own pipeline can
  pass while the real one is misassembled.
- Cover the properties this project exists to demonstrate explicitly: tenant
  isolation across the role matrix, and idempotency under replay. Happy-path
  coverage is not sufficient.
- **Verify a guard by breaking what it guards.** Every isolation test here was
  confirmed to fail with row-level security disabled, with a policy missing, or
  with a repository predicate removed. A test that has never failed has not been
  shown to test anything.

## Configuration

Nothing loads `.env` implicitly. Nest reads it when `ConfigModule` is
registered, and drizzle-kit loads it for its own config — but scripts and test
runs must ask for it, which they do with `node --env-file-if-exists=.env`. The
`-if-exists` form matters: CI supplies the environment directly and has no file.

Connection settings are validated once at startup rather than at first query,
reporting every missing key at once, and refuse to start if a runtime identity
is pointed at the schema owner.

## Local environment

`docker compose up -d` provides Floci (4566), PostgreSQL (5432) and Cube.dev
(4000 REST/playground, 15432 SQL API). Container runtime state must never be
written into the source tree; bind mounts that a root container writes to are
shadowed by named volumes.
