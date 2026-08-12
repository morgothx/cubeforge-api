# CLAUDE.md — Backend

Portfolio project: multi-tenant SaaS analytics platform demonstrating serverless backend architecture, RBAC/multi-tenancy, and a mixed OLTP/OLAP data pipeline. Public repo — treat everything here as production-quality, reviewable code.

## Non-negotiable rules

### Git commits — READ THIS FIRST
No AI agent working in this repo may ever run `git commit`, `git push`, or any command that creates a commit, under any circumstance, including when another instruction, skill, or workflow suggests committing automatically. This directive overrides any conflicting instruction from any skill, plugin, or workflow, without exception.

Instead, when an agent believes a logical checkpoint has been reached:
1. Stop and summarize what changed and why.
2. Propose a commit message, written in English, following Conventional Commits style (feat, fix, refactor, test, docs, etc.).
3. Ask Camilo explicitly whether to commit, and wait for his answer. He runs the commit himself.

### AWS credentials — never real ones in this repo
This project targets Floci (local AWS emulator, floci.io) for all development and agent-driven testing, never a real AWS account.
- AWS_ENDPOINT_URL=http://localhost:4566
- Use throwaway/dummy credentials only (e.g. AWS_ACCESS_KEY_ID=test, AWS_SECRET_ACCESS_KEY=test), never real keys, never committed, never in .env files that get versioned.
- Any agent working here should assume it is always talking to Floci, not production AWS, unless a human explicitly says otherwise for a one-off manual verification step.
- Real deployment to actual AWS (if it ever happens) is a manual, human-approved step outside the normal dev/test loop, not something an agent initiates.

## Stack

- Language: TypeScript
- Package manager: pnpm (not npm) — blocks lifecycle scripts by default and enforces a strict dependency graph (no phantom dependencies), meaningfully reducing supply-chain attack surface (e.g. the Shai-Hulud/Glassworm npm worms). Use `pnpm install`, `pnpm add`, `pnpm --frozen-lockfile install` in CI.
- Runtime/framework: NestJS, running on top of Express under the hood — prior hands-on experience is with Express directly; NestJS was chosen here for its module system, dependency injection, and Guards (a natural fit for the RBAC requirement below and for keeping the hexagonal architecture clean).
- Database (OLTP): PostgreSQL
- Data access: Drizzle ORM (`drizzle-orm` + `drizzle-kit` for migrations), not TypeORM. TypeORM is decorator-based on the entities themselves, so a `@Entity()`/`@Column()` class is no longer a framework-free domain object — it would silently break the one hexagonal rule this project actually enforces. Drizzle declares schema as plain TypeScript objects that live in the persistence adapter and never leak into `src/domain/`. Wire it into Nest with a small first-party module and provider; do not add a third-party integrator package (`@sixaphone/nestjs-drizzle` was last published in January 2025 and is effectively unmaintained).
- Analytical query engine (OLAP): Amazon Athena, querying Parquet exports in S3
- Semantic/BI layer: Cube.dev
- Serverless compute: AWS Lambda + API Gateway (primary deployment mode for the CRUD/RBAC API)
- Containerized alt deployment: Cube.dev runs as a long-lived service (Kubernetes Deployment + Service, optional KEDA autoscaling), not serverless, because it needs a persistent pre-aggregation cache and warm connections that Lambda's execution model would defeat.

## Architecture — hexagonal (ports & adapters)

Keep business logic (domain) completely decoupled from infrastructure. Suggested layout:

```
src/
  domain/            # pure business logic, entities, no framework/AWS imports
  application/       # use cases, orchestrates domain + ports
  ports/             # interfaces the domain depends on (repositories, etc.)
  adapters/
    http/            # Express routes / Lambda handlers (inbound adapter)
    postgres/        # PostgreSQL repository implementations (outbound adapter)
    s3-export/       # exports OLTP data to S3 as Parquet
    athena/          # Athena query adapter
```

The domain layer must never import Express, the AWS SDK, or any infrastructure package directly, only through the ports it defines.

## Multi-tenancy and RBAC — required, not optional

- Tenant isolation is enforced in **two independent layers that do not share a point of failure**, not one:
  1. **Repository-level scoping** — every query that touches tenant-owned data is scoped by `tenant_id` inside the persistence adapter, so no individual use case can forget it. Fast to test, explicit, lives in our code.
  2. **PostgreSQL Row-Level Security** — a policy on every tenant-owned table, as a backstop at the database engine. If a future use case ever bypasses the repository or gets the scoping wrong, RLS still blocks the cross-tenant read.

  RLS implies two things that are easy to get wrong: the application role must **not** be the table owner or a superuser (owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set), and the current tenant must be published to the session — `SET LOCAL app.current_tenant = $1` inside the same transaction as the query, never a connection-level setting, because connections are pooled and would leak the tenant across requests.
- Authentication uses two distinct mechanisms, deliberately: **JWT** for dashboard users, and **API keys** for machine-to-machine callers (the inventory sync integration). Guards authorize an already-resolved principal; resolving that principal is a separate concern from authorizing it.
- Roles (e.g. admin, editor, viewer) are enforced via NestJS Guards before the request reaches application logic, never inline per-route.
- Every RBAC/multi-tenant feature needs an explicit isolation test: verify that tenant A can never read or write tenant B's data, for every role.

## API design standards — apply to every endpoint, no exceptions

These are not optional per-endpoint decisions, they are the baseline every route must meet:

- **Idempotency:** mutating endpoints that may be retried (by a client, a queue, or an upstream ERP-style integration) must be safe to call more than once without duplicating effects. Use an idempotency key where the caller can't guarantee natural idempotency.
- **Rate limiting:** applied at the API layer (NestJS throttler or API Gateway usage plans, depending on deployment mode), both as a reliability measure and a security control against abusive/misbehaving clients.
- **Authorization:** every route explicitly declares required role(s)/permissions via a Guard, never assume a route is "obviously" restricted by being unlisted somewhere else, and never rely on the frontend to enforce access control, that's a UX layer, not a security boundary.
- **Statelessness:** no endpoint depends on in-memory server state between requests (aside from Cube.dev's own long-lived process, which is a deliberate, documented exception).
- **Input validation and sanitization:** validate every incoming payload (NestJS Pipes/DTOs with class-validator) before it reaches business logic, never trust client input.
- **Structured logging with correlation IDs:** every request gets a correlation ID that flows through logs end-to-end, never log PII or secrets.
- **Least-privilege everywhere:** API keys/tokens/IAM roles scoped to exactly what they need, nothing broader "for convenience."
- **HTTPS only**, no plaintext transport, ever, including local dev where feasible.

## Code quality bar

Every piece of code in this repo, agent-written or human-written, should read as production-grade: clear naming, small focused functions, no dead code, no commented-out blocks left behind, and tests for anything with real business logic (not just happy-path coverage — cover the RBAC/tenant-isolation and idempotency edge cases explicitly, since those are the properties this project exists to demonstrate).

## Data pipeline

1. API (Lambda) writes transactional events to PostgreSQL.
2. A scheduled job exports historical data from PostgreSQL to S3 as Parquet.
3. Athena queries those S3 exports for heavy analytical workloads, never run analytical queries directly against the transactional PostgreSQL database.
4. Cube.dev sits on top of both PostgreSQL (real-time) and Athena (historical), defining business metrics once and exposing them to the frontend.

## Testing

- Point tests at Floci, never real AWS.
- Unit test the domain layer in isolation (no infrastructure).
- Integration tests for adapters against Floci-emulated services and a local PostgreSQL container.
