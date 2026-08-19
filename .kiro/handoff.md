# Handoff — cubeforge-api

Written 2026-08-18. Receiver: the next agent session (Claude or Codex). Read
this, then `.kiro/specs/caller-identity/tasks.md`.

## Where things stand

- **Feature 1 `tenant-and-user-management`: complete.** 32/32 tasks, spec phase
  `implemented`.
- **Feature 2 `authentication`: complete.** 33/33 tasks, spec phase
  `implemented`.
- **Feature 3 `rbac-authorization-guards`: complete.** 19/19 tasks, spec phase
  `implemented`.
- **Feature 4 `caller-identity`: complete.** 10/10 tasks, spec phase
  `implemented`. Delivers `GET /me`, which the frontend could not start
  without — a client that just signed in now learns its own tenants and role.
- Tarea activa: **ninguna.** The four backend features on the roadmap through
  `caller-identity` are done. Next is `frontend-shell`, which needs its own
  `.kiro/` inside `cubeforge-web` — that repo still holds only an `.nvmrc`.
- Último commit: tasks 4.2 and 4.3 of `caller-identity`. **Uncommitted in the
  tree:** task 5.1. One earlier commit, tasks 4.1–4.4 of
  feature 3, has a typo'd subject: `eat(...)`.
- Ciclo TDD: 5.1 RED (one test, on a status the task did not pin) → GREEN →
  VERIFIED by three probes. One of them showed the freshness tests were not
  yet load-bearing and they were repaired before the task closed.
- **Integration work needs the database up.** `docker compose up -d postgres`,
  and `pnpm db:bootstrap` once on a fresh volume.
- Tests corridos: `pnpm test` 344 passing, `pnpm test:integration` 149 passing,
  `pnpm lint`, `pnpm typecheck` and `pnpm build` clean. Last run: all green.
- **`pnpm typecheck` is new** (`tsc --noEmit`) and reports zero errors. It was
  added after 1.2 because nothing in this repo type-checked a spec file; the 34
  errors it first found are all repaired. Run it at every checkpoint — in 2.1 it
  was half the RED, catching a declaration shape the union did not yet carry.
- Próximo paso exacto: scaffold `cubeforge-web` (Vite + React + TS + its own
  `.kiro/`), outside the Kiro cycle, then spec `frontend-shell`.
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

## Next: `frontend-shell`

Features 1–4 are `implemented` and nothing in them is outstanding. Feature 4
delivered one route, `GET /me`, and was larger than that sounds: it touches the
actor union, the resolver, the access declaration and its guard, and the
persistence layer, because none of those could express "a person acting in no
tenant". Section 1 built the principal and the resolver and section 2 the
declaration and its guard branch, so **a route can now be declared open to any
authenticated person and the guard enforces it**. Task 3.1 added the database
half: `current_person_id()`, a `SELECT` for `cubeforge_authenticator` on
`memberships`, and a policy confining it to the published person, and 3.2 the
repository over it — `runAsPerson`, `StandingRepository`, and one contract suite
both implementations pass. Task 4.1 added `DescribeCallerUseCase`, which drops
every membership `decideAccess` does not grant, 4.2/4.3 the route itself and
the suites that enumerate routes, and 5.1 the end-to-end proof against the real
database. **`GET /me` works end to end**, from a session obtained the way a
person actually obtains one.

The platform's entrance is unchanged:

```
pnpm ops:bootstrap-operator founder@example.com
  → creates the person if absent, records them as an operator,
    prints one setup token
POST /auth/credentials {"token": "…", "password": "…"}
POST /auth/sign-in
```

`ops:grant-operator` is unchanged and still refuses an address it cannot find —
that guard is task 2.3's, and widening it would have removed the only protection
against a typo creating a stray operator. The two commands are deliberately
separate: one creates, the other does not.

After this feature the roadmap's next step is `frontend-shell`, which needs its
own `.kiro/` inside `cubeforge-web` — that repo still holds only an `.nvmrc`.

Composition itself is done: `AuthenticationModule` binds the crypto ports and
the throttler, `PersistenceModule` the two units of work, `SystemModule` the
clock, identifiers and correlation middleware. The unit suite boots the real
`AppModule` through `createInMemoryApplication`, so a missing registration now
fails a test.

The routes that now exist:

```
POST   /tenants                                   201 {id, name, status, createdAt, administratorPersonId}
POST   /auth/sign-in                              200 {accessToken, refreshToken, sessionExpiresAt}
POST   /auth/refresh                              200 same shape
POST   /auth/sign-out                             204
POST   /auth/credentials                          204  (redeem a setup token)
POST   /platform/people/:personId/setup-tokens    201 {setupToken}   operator only
POST   /tenants/:tenantId/api-keys                201 {id, secret}   tenant admin
GET    /me                                        200 {personId, email, isOperator, memberships[]}
GET    /tenants/:tenantId/api-keys                200 summaries, never a secret
DELETE /tenants/:tenantId/api-keys/:apiKeyId      204
```

## Things that will bite you

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
docker compose up -d postgres     # the local database
pnpm db:bootstrap                 # once per fresh database
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
pnpm ops:bootstrap-operator <email>  # the first way in: creates, records, issues a token
pnpm ops:grant-operator <email>      # promotes an existing person; refuses an unknown one
```

## Conventions

- Converse with Camilo in Spanish; every repository artifact in English.
- Strict TDD: RED, GREEN, REFACTOR, VERIFY. Write the failing test first.
- Verify a guard by breaking what it guards, not by watching it pass.
- Record findings in the `## Implementation Notes` section at the bottom of
  `tasks.md`, so the next feature inherits them.
