# Structure

*Updated: 2026-08-12*

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
    ports/                     # interfaces the domain and use cases depend on
  adapters/
    http/                      # controllers, DTOs, Guards
    persistence/postgres/      # Drizzle schema and repository implementations
  shared/                      # correlation IDs, logging, typed errors
  app.module.ts                # composition root
  main.ts                      # Express bootstrap
```

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

## Composition

`app.module.ts` is the composition root: the single place where ports are bound
to concrete adapters through Nest's DI container. Feature modules are imported
there. The domain layer never appears in it directly.

`main.ts` and the eventual `lambda.ts` share the same `AppModule`, which is what
keeps serverless a deployment mode rather than a parallel architecture.

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
- **Tests**: `*.spec.ts` beside the unit under test; e2e in `test/`.

## Beyond src

- `.kiro/steering/` — project memory (this directory).
- `.kiro/specs/` — per-feature requirements, design and tasks.
- `cube/model/` — Cube.dev semantic models. Runtime state written here by the
  container is shadowed by a named volume and must never be committed.
- `docker-compose.yml` — the whole local environment in one command.

## Companion repository

The dashboard lives in `cubeforge-web`, a separate repository with its own
steering. It consumes this API and must never reach PostgreSQL or Athena
directly — always through the semantic layer.
