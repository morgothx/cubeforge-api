# Structure

*Updated: 2026-08-29*

## Organizing principle

Source is grouped **by architectural layer first**, not by feature. This is a
deliberate departure from the NestJS idiom, which colocates
`controller` + `service` + `module` per feature.

The departure is scoped, not dogmatic. Hexagonal boundaries are applied only
where they buy something concrete:

1. **A pure domain layer**, so tenant-isolation and RBAC rules — the properties
   this project exists to demonstrate — can be tested without a DI container or
   an HTTP layer.
2. **Ports for seams with genuinely alternative adapters**: the data repository
   (PostgreSQL in production, in-memory in tests) and the Express/Lambda inbound
   boundary, since both entry points share one `AppModule`.

Everywhere else, plain NestJS conventions win. Do not create an interface and an
injection token for a component that will only ever have one implementation —
the Athena client is the canonical example. Uniform indirection reads as
architecture for its own sake.

## Layout

```
src/
  domain/                      # entities, value objects, business rules
  application/
    ports/                     # interfaces the use cases depend on
    <aggregate>/               # one file per use case
  adapters/
    http/                      # controllers, DTOs, filters, middleware
    cli/                       # arguments, output and exit status for commands
    persistence/postgres/      # Drizzle schema and repository implementations
    persistence/in-memory/     # the same ports, for tests
    storage/                   # object storage and the columnar encoding
    crypto/                    # hashing, token issuing, secret generation
    system/                    # clock, identifier generation
    testing/                   # deterministic adapters used only by tests
  <feature>.module.ts          # binds this feature's ports to adapters
  app.module.ts                # imports feature modules
  main.ts                      # Express bootstrap
scripts/                       # operator and setup entry points, run by pnpm
drizzle/                       # migrations, numbered in the order they land
```

An operator command keeps its testable parts in `adapters/cli/` and leaves
`scripts/` a thin bootstrap. `scripts/` is outside `rootDir` for the unit
tests, so anything with a decision in it — parsing arguments, deciding an exit
status, formatting a report — belongs in `src/` where it can be tested.

Adapters are grouped by the technology behind them, not by the port they
implement, because that is the axis along which they get replaced: swapping
PostgreSQL for something else touches one directory.

## Dependency rule

Dependencies point inward. `domain` knows nothing about anything else.

| Layer | May import |
|---|---|
| `domain/` | itself only — no framework, no infrastructure, no outer layer |
| `application/` | `domain`, its own ports, Nest decorators |
| `adapters/` | anything |

This is **enforced, not documented**. `eslint.config.mjs` carries
`no-restricted-imports` rules that fail the lint if `src/domain/**` imports
`@nestjs/*`, the AWS SDK, `express`, `pg`, `typeorm`, or an outer layer.
`src/application/**` may use Nest decorators for DI but may not reach a concrete
adapter. If a rule needs relaxing, that is an architectural decision to discuss,
not a lint annotation to add.

The one exemption is `src/application/**/*.spec.ts`: a use-case test has to
instantiate the doubles it runs against, which is what ports exist for. Spec
files are excluded from the build output, so nothing exempted can ship.

## Composition

Ports are bound to adapters **per feature module** — `identity.module.ts` is the
first — and `app.module.ts` imports those modules. Keeping the bindings beside
the feature means a reviewer sees the whole wiring of one capability in one
file, and a feature can be lifted out without untangling a shared root. The
domain layer never appears in either.

Use cases are constructed by the DI container in production and by hand in
tests. Both must stay possible: a use case that can only be built by Nest has
acquired a dependency on the framework it was kept away from.

`main.ts` and the eventual `lambda.ts` share the same `AppModule`, which is what
keeps serverless a deployment mode rather than a parallel architecture.

**A feature module is not always imported by `app.module.ts`.** One whose entry
point is a command rather than a route is booted by that command with
`NestFactory.createApplicationContext`, and the API never sees it — otherwise
the API would refuse to start over configuration it never uses.
`export.module.ts` is the first. The test for whether a module belongs in
`AppModule` is whether a request can reach it, not whether it is part of the
product.

## Working with the generator

**Do not use `nest g` for structure.** The generator assumes Nest's
feature-first layout and will write to `src/<feature>/`, ignoring this one.
Create files by hand, in the layer they belong to.

## Conventions

- **Files**: kebab-case, suffixed by role — `tenant.repository.ts`,
  `create-tenant.use-case.ts`, `roles.guard.ts`.
- **Classes**: PascalCase matching the filename.
- **Ports**: named for the capability, not the technology —
  `TenantRepository`, not `PostgresTenantRepository`. The implementation carries
  the technology name.
- **Tokens**: `SCREAMING_SNAKE_CASE` constants colocated with the port.
- **Tests**: `*.spec.ts` beside the unit under test, run by `pnpm test` with no
  infrastructure. `*.integration-spec.ts` under `test/integration/`, run by
  `pnpm test:integration` against the local database and the emulator,
  single-worker because they share one and reset it by truncating. A
  prerequisite an integration suite needs — a migrated database, a bucket that
  exists — is arranged by a fixture the suite calls, never as a side effect of
  whichever suite happens to run first.

## Beyond src

- `.kiro/steering/` — project memory (this directory).
- `.kiro/specs/` — per-feature requirements, design and tasks. Each `tasks.md`
  ends with `## Implementation Notes`: the findings from building it that the
  next feature should not have to rediscover.
- `scripts/` — entry points run through `pnpm`, one per operator task.
- `drizzle/` — migrations, numbered in the order they land rather than the order
  a design imagined them.
- `test/integration/support/` — the fixtures every integration suite shares.
- `cube/model/` — Cube.dev semantic models. Runtime state written here by the
  container is shadowed by a named volume and must never be committed.
- `docker-compose.yml` — the whole local environment in one command.

## Companion repository

The dashboard lives in `cubeforge-web`, a separate repository with its own
steering. It consumes this API and must never reach PostgreSQL or Athena
directly — always through the semantic layer.
