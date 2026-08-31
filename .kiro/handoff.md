# Handoff — cubeforge-api

Written 2026-08-31, replacing the 2026-08-18 version. Receiver: the next agent
session (Claude or Codex). Read this, then the `## Implementation Notes` at the
bottom of `.kiro/specs/athena-analytics-query/tasks.md`.

## Where things stand

Roadmap features **1 through 7 are complete**, every spec at phase
`implemented`. `cubeforge-web` holds `frontend-shell` (step 4) and
`dashboard-appearance`, both `implemented` too.

| # | Feature | Tasks |
|---|---|---|
| 1 | `tenant-and-user-management` | 32/32 |
| 2 | `authentication` | 33/33 |
| 3 | `rbac-authorization-guards` | 19/19 |
| — | `caller-identity` | 10/10 — `GET /me` |
| 5 | `inventory-sync-api` | 21/21 |
| 6 | `s3-data-export` | 20/20 |
| 7 | `athena-analytics-query` | 18/18 |

- Tarea activa: **ninguna.** Feature 7 closed on 2026-08-31;
  `/kiro-validate-impl` returned GO.
- Tests: `pnpm test` **617 passing / 73 suites**, `pnpm test:integration`
  **320 passing / 43 suites**, `lint:check`, `typecheck` and `build` clean.
  Three consecutive full integration runs, ~135 s each.
- Próximo paso exacto: `/kiro-spec-init cube-semantic-layer` (step 8). The fork
  it has to decide is written out below — settle it in the spec, not later.
- **Integration work needs the whole stack now**, not just PostgreSQL:
  `docker compose up -d` brings up `postgres`, `floci` and `cube`. Analytics
  suites talk to Floci's Athena, Glue and S3.
- When a task run resumes: `/kiro-impl <feature> <numbers>` — **with the task
  numbers**, which is what selects manual mode. Manual mode has no commit step
  at all; without numbers it commits per task and breaks the rule below.

Camilo commits. Propose a message, never run `git commit`.

## The rule that overrides everything

No agent runs `git commit`, `git push`, or anything that creates a commit, in
either repository, ever — including when a skill suggests it. Reach a checkpoint,
summarize, propose a Conventional Commits message in English, and wait.

`/kiro-impl` autonomous mode commits per task, so it is banned. Use **manual mode,
block by block**. This was decided in an earlier session and reaffirmed.

## Next: `cube-semantic-layer` (step 8)

Feature 7 left step 8 a fork, and it is the first thing the spec has to settle.
`athena-analytics-query/design.md` records it under *Open questions*: **does Cube
consume the `TenantScopedAnalytics` port, or define its own models over the same
Glue tables?**

The fact that decides it is in `docker-compose.yml`. **Cube runs in its own
container** (`cubejs/cube`, ports 4000 and 15432) and today is pointed at
PostgreSQL only — `CUBEJS_DB_TYPE: postgres`. It cannot inject a Nest provider,
so "consume the port" means exposing that port over HTTP and writing a Cube
driver against it: real work, and a second network hop on every question.

Its own connection to Athena is far more natural for Cube — and it **duplicates
the place a tenant filter can be lost**, which is precisely what feature 7 spent
itself making inexpressible. Cube's `queryRewrite` and `securityContext` are the
tools for that, but they are a *second* isolation layer that has to be proven
from nothing rather than inherited. Whichever way it goes, the isolation story is
the one this project exists to tell, so the probe comes with the decision.

Everything feature 7 built that step 8 can lean on:

- `TenantScopedAnalytics` / `TenantAnalytics` — the seam, in
  `src/application/ports/tenant-scoped-analytics.ts`. No method takes a tenant.
- `AthenaAnalytics` — the only file that holds a statement.
- `catalogue-definition.ts` — the four Glue tables (`movements`, `products`,
  `locations`, `watermarks`) with partition projection, built from the export's
  published column contract in `src/domain/export/exported-row.ts` so a rename
  breaks a build. Applied by `pnpm ops:analytics-catalogue`.
- The watermark: one row per tenant, `complete_through`, written by the export
  **after** the cursor is confirmed. A tenant with no watermark has never been
  carried, which is a different answer from an empty one.

The routes that now exist:

```
POST   /tenants                                        201
GET    /tenants                                        200
DELETE /tenants/:tenantId                              204
POST   /auth/sign-in                                   200 {accessToken, refreshToken, sessionExpiresAt}
POST   /auth/refresh                                   200 same shape
POST   /auth/sign-out                                  204
POST   /auth/credentials                               204  (redeem a setup token)
GET    /me                                             200 {personId, email, isOperator, memberships[]}
POST   /platform/people/:personId/setup-tokens         201 {setupToken}   operator only
DELETE /platform/people/:personId                      204               operator only
POST   /tenants/:tenantId/members                      201
GET    /tenants/:tenantId/members                      200
PATCH  /tenants/:tenantId/members/:membershipId        200
DELETE /tenants/:tenantId/members/:membershipId        204
POST   /tenants/:tenantId/api-keys                     201 {id, secret}   tenant admin
GET    /tenants/:tenantId/api-keys                     200 summaries, never a secret
DELETE /tenants/:tenantId/api-keys/:apiKeyId           204
PUT    /tenants/:tenantId/inventory/products/:sku      200
GET    /tenants/:tenantId/inventory/products           200
PUT    /tenants/:tenantId/inventory/locations/:code    200
GET    /tenants/:tenantId/inventory/locations          200
POST   /tenants/:tenantId/inventory/movements          201
POST   /tenants/:tenantId/inventory/movements/batch    200
GET    /tenants/:tenantId/inventory/stock              200
GET    /tenants/:tenantId/analytics/movements          200 {state, completeThrough?, entries?}
```

The platform's entrance is unchanged:

```
pnpm ops:bootstrap-operator founder@example.com
  → creates the person if absent, records them as an operator,
    prints one setup token
POST /auth/credentials {"token": "…", "password": "…"}
POST /auth/sign-in
```

## Things that will bite you

The list grew with features 5, 6 and 7. The newest are first; each spec's
`## Implementation Notes` carries the full account.

- **Floci is not AWS, and five gaps are measured rather than suspected.**
  (1) It needs no partitions registered — it derives `tenant_id` from the key
  path, so a *correct* partition projection and a *missing* one look identical
  locally. (2) Every column comes back as `varchar` whatever its real type, so
  an adapter typing a result from the engine's metadata passes here and is wrong
  in production — decode against the declared shape instead. (3)
  `ExecutionParameters` are dropped, which is why the tenant is interpolated
  into the statement after a UUID check rather than bound. (4) `glue:GetTable`
  returns `LastAccessTime: null`, which the JS SDK refuses to deserialize.
  (5) An empty prefix is `IO Error: No files found that match the pattern`, not
  zero rows — the engine builds a view over every prefix on every question.
  **The engine underneath is DuckDB, not Presto.** Do not teach an adapter to
  match on a driver's wording to paper any of this over; arrange the fixture
  around it, as `test/integration/support/analytics.ts` does.
- **A check that cannot fail is not a check, and the repair goes both ways.**
  An instrument reading `pg_stat_all_tables` scan counters reported that the
  route whose whole job is to sum `stock_movements` had not touched it — the
  statistics flush per backend on a schedule a request-shaped window never sees.
  It was replaced (by a spy on `runInTenant`) because a **positive control**
  caught it. Separately, a throttling test that no probe could falsify was
  *deleted*, because there was nothing to replace it with. Give every
  measurement a case that must make it report something.
- **A double looser than the thing it stands for hides the bug it exists to
  catch.** This cost four separate instances in feature 6 and recurred in 7 at
  the scale of an entire engine. If the real thing refuses, the double refuses
  the same way and at the same moment — synchronously if the real one throws
  synchronously.
- **Run every probe and read what it did.** A probe that fails nothing is a
  claim about the probe. Read the test *count*, not only pass/fail: a patch that
  dropped a bracket reported "4 passed of 20" while the suites never compiled.
- **`ThrottlerModule` is global: a bucket a route does not skip counts that
  route.** Four hand-written skip lists existed and adding a fifth bucket
  required editing all of them, invisibly. They are derived from one registry
  now (`throttling-buckets.ts`); `everyBucketExcept` refuses a name nothing
  registers. `THROTTLER_SKIP` is declared in `@nestjs/throttler`'s types and
  **not exported at runtime** — importing it type-checks and yields `undefined`,
  turning every metadata lookup into a silent miss.
- **A `beforeAll` fixture seeds before the per-test cleanup runs.** A fixed
  tenant name collides with whatever the previous suite left behind, so the
  suite fails as a whole roughly one run in three and never in isolation.
  Generate the name. This bit twice, one directory apart — grep for the shape,
  not only for the file that taught it.
- **`pnpm lint --fix` reformats a block between a write and a patch.** Five
  instances. Every replacement in a patch script needs its own assertion that it
  matched; one shared `assert s != before` passes on a different replacement.
- **`git checkout` cannot restore an untracked file.** Swallowed by `|| true`, it
  leaves a broken file behind and the wrong test count is what catches it.
- **The export bucket has to be emptied once per integration run.** The engine
  rebuilds a view over the whole prefix on every question, so leftovers from
  earlier runs made analytics suites fail ~2 runs in 3 and doubled the suite's
  time. `test/integration/support/global-setup.ts` does it.
- **The API must start without analytical configuration.** `AnalyticsModule` is
  imported by `AppModule`, so a provider factory reading the environment would
  take sign-in and inventory down over a setting one route uses.
  `DeferredAnalytics` builds at the first question. The export is the deliberate
  opposite — it is a command, and refusing early costs nobody anything. **The
  same requirement produces opposite answers in the two modules.**
- **The export cursor is a transaction-id horizon, never a timestamp.**
  `recorded_at` is when a transaction *began*, so a movement whose transaction
  started earlier and committed later would be skipped for ever.
  `pg_snapshot_xmin(pg_current_snapshot())` is the line below which nothing is
  still in flight.
- **Neither `pnpm test` nor `pnpm build` type-checks a spec file.** The build
  excludes `**/*spec.ts` and `ts-jest` transpiles without checking, so an
  impossible object in a test compiles, runs and passes. **Run `pnpm typecheck`**
  — added for exactly this, and clean as of 2026-08-17, after the 34 errors it
  first surfaced were repaired. There is no CI yet, so this gate is only as good
  as remembering it: run it beside lint and build at every checkpoint.
- **Declare `implements` on an adapter, always.** Nest's `useClass` and
  `useFactory` accept a provider that merely resembles its token, so a port is
  not a contract until a class says it satisfies one. `JwtAccessTokenIssuer`
  returned a bare `string` where the port promises a branded `AccessToken` for
  as long as that declaration was missing, and `accessToken()` was called
  nowhere in the repository — a nominal type nothing produced.
- **An error message that echoes its input can answer for its own reason.**
  `assertUsable` appends the declaration JSON to every message, so a test
  matching `/person.*machines/` matches `{"person":true,"machines":true}`
  whatever the check concluded — one such test passed before the branch it was
  written for existed. Assert against the reason with the echo stripped.
- **`ts-jest` emits CommonJS, which is not strict mode.** An assignment to an
  undeclared name creates a global instead of throwing, so a spec can reference
  variables that do not exist and still pass. `pnpm typecheck` is what catches
  it; three such names lived in `access.guard.spec.ts`.
- **A test can freeze the *absence* of a grant.** Adding `SELECT ON memberships`
  for `cubeforge_authenticator` turned red a test asserting `permission denied`
  on that exact table — the boundary had been written down as a guarantee.
  Before adding any grant, grep the integration suites for the table name.
- **`isOperator` means "an active operator", so `false` covers two very
  different people.** A deactivated operator and an ordinary member are the same
  answer. Branching on it alone to choose between principals resolved a
  deactivated operator to a plain `person` — deactivation granting access
  instead of removing it. Check the person's status separately, and first.
- **`jose` is out, `@nestjs/jwt` is in.** jose is ESM-only; Node 22 can
  `require()` it but Jest's runtime cannot, and pnpm's layout defeats
  `transformIgnorePatterns`. Do not reintroduce it without moving Jest to ESM.
- **Verify a dependency under the test runner *and* the compiled output**, not
  just under Node. Task 1.1 exists because that shortcut failed once already.
- **`isolatedModules` forbids ambient const enums.** `@node-rs/argon2`'s
  `Algorithm` is one: unit tests pass while `pnpm build` fails, because ts-jest
  transpiles without type-checking. Run the build.
- **A new declaration shape needs its own pairing in `declaration-drift.spec.ts`.**
  Both existing pairings filter on `roles` and on `operator`, so `GET /me`
  declaring `{ person: true }` sailed past the one file written to make that
  impossible. `PERSON_ROUTES` now closes it. Adding a fifth shape later will
  have the same hole until somebody adds the fourth pairing.
- **Assert *which* refusal, never that there was one.** Three tasks in this
  feature have now had a test pass for the wrong reason: satisfied by an error's
  own echo (2.1), by a branch that refused everything (2.2), and by a caller who
  simply did not exist (4.1). `rejects.toBeInstanceOf(DomainViolation)` proves
  almost nothing — match on `{ error: { kind } }`, and seed the fixture so the
  cheaper refusal cannot fire first.
- **The standing read returns domain entities, not the response shape.**
  `decideAccess` needs a `Tenant`, a `Person` and a `Membership`, and task 4.1
  filters with it — so `CallerStandingRecord` carries revoked memberships and
  inactive tenants intact and the use case flattens. A repository that filtered
  would be a second copy of a domain rule. The design said otherwise and has
  been corrected.
- **`standing` is reachable only from `runAsPerson`.** It is not a field on
  `AuthenticatorRepositories`: there, the read would compile with nobody
  published and answer `null`, which is indistinguishable from a caller who
  belongs nowhere. Two bundles, and the mistake does not type-check.
- **One contract suite, two implementations.** `describesCallerStanding` in
  `src/adapters/testing/standing-repository.contract.ts` is parameterized by a
  seeding harness; the in-memory spec and `caller-standing.integration-spec.ts`
  supply only the seeding. Add a case there, not in one of them.
- **`InMemoryAuthenticatorUnitOfWork` now takes a third argument**, the identity
  store as a read-only directory. Required on purpose — an optional one would
  make `runAsPerson` behave differently per wiring. Specs with nothing to read
  pass `new InMemoryIdentityStore()`.
- **Adding a field to a repository bundle obliges every adapter**, including the
  Postgres ones. That is how a slice of task 5.1 landed inside 4.1.
- **A before-and-after test needs the before.** Three freshness tests in 5.1
  asserted the state after a change and only one of them asked beforehand — so a
  cache keyed on the caller, the exact thing requirement 4.1 forbids, failed
  only that one. Make the first call, assert the old value, then change.
- **A refusal that writes something cannot `throw` inside the transaction.** The
  rollback discards the write. Refresh invalidates a token family and then
  rejects; throwing undid the invalidation. Return a verdict from the
  transaction and raise the rejection after it commits. Any use case whose
  rejection has an effect has this shape.
- **`FORCE ROW LEVEL SECURITY` applies to the schema owner too.** Anything the
  migration identity must read or write needs an owner policy — see migrations
  0002 and 0007.
- **Throttling counters live in process memory** (`@nestjs/throttler` 6.5). With
  two instances the effective limit doubles; a shared `ThrottlerStorage` is the
  fix, and it is a change to `AuthenticationModule` alone.
- **`DomainViolation` takes an optional second argument**, a fixed phrase logged
  with the correlation identifier and never returned. Use it for every
  authentication refusal; never interpolate the value that failed.
- **The edge cannot reconcile the path tenant against the actor.** The principal
  is *built* from the path segment, so the comparison the old `actingIn` made
  could never fail. Do not add it back; membership is settled by
  `authorizeInTenant` inside the tenant transaction.
- **Running one integration spec needs the env file**:
  `node --env-file-if-exists=.env node_modules/jest/bin/jest.js --config
  ./test/jest-integration.json <path>`. Plain `pnpm jest` on an integration spec
  fails in global setup with a missing-configuration error.
- Nothing loads `.env` implicitly. Scripts and test runs use
  `node --env-file-if-exists=.env`.
- The four database roles need `pnpm db:bootstrap` once on a fresh database,
  before `pnpm db:migrate`.

## Commands

```
docker compose up -d                 # postgres, floci (AWS emulator), cube
pnpm db:bootstrap                    # once per fresh database
pnpm db:migrate
pnpm lint:check && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
pnpm ops:bootstrap-operator <email>  # the first way in: creates, records, issues a token
pnpm ops:grant-operator <email>      # promotes an existing person; refuses an unknown one
pnpm ops:export                      # PostgreSQL → Parquet on S3, per tenant
pnpm ops:analytics-catalogue         # creates or refreshes the Glue tables
```

`pnpm lint` is `eslint --fix` and rewrites files; `pnpm lint:check` is the gate.
All of it targets Floci — `AWS_ENDPOINT_URL=http://localhost:4566`, throwaway
credentials, never a real account.

## Conventions

- Converse with Camilo in Spanish; every repository artifact in English.
- Strict TDD: RED, GREEN, REFACTOR, VERIFY. Write the failing test first.
- Verify a guard by breaking what it guards, not by watching it pass.
- Record findings in the `## Implementation Notes` section at the bottom of
  `tasks.md`, so the next feature inherits them.
