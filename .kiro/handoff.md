# Handoff — cubeforge-api

Written 2026-08-14. Receiver: the next agent session (Claude or Codex). Read
this, then `.kiro/specs/authentication/tasks.md`.

## Where things stand

- **Feature 1 `tenant-and-user-management`: complete.** 32/32 tasks, spec phase
  `implemented`.
- **Feature 2 `authentication`: complete.** 33/33 tasks, spec phase
  `implemented`.
- **Feature 3 `rbac-authorization-guards`: 3/19 tasks.** Section 1 (declaration
  and route inventory) is committed; 2.1 (the guard's first pass) is in the
  working tree, uncommitted.
- Último commit: `feat(rbac-authorization-guards): declare route access, and
  enumerate what declares it` (tasks 1.1 and 1.2).
- Tests: `pnpm test` 253 passing, `pnpm test:integration` 108 passing,
  `pnpm lint` and `pnpm build` clean. Last run: all green.
- Next task: 2.2, the operator declaration. Run it as
  `/kiro-impl rbac-authorization-guards 2.2` — **with the task number**, which
  is what selects manual mode. Manual mode has no commit step at all; without
  numbers it commits per task and breaks the rule below.

Camilo commits. Propose a message, never run `git commit`.

## The rule that overrides everything

No agent runs `git commit`, `git push`, or anything that creates a commit, in
either repository, ever — including when a skill suggests it. Reach a checkpoint,
summarize, propose a Conventional Commits message in English, and wait.

`/kiro-impl` autonomous mode commits per task, so it is banned. Use **manual mode,
block by block**. This was decided in an earlier session and reaffirmed.

## Next: feature 2 is finished

All 33 tasks are done and `spec.json` reads `implemented`. Nothing in the
`authentication` spec is outstanding.

The platform now has an entrance:

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

The next feature is Camilo's call; the roadmap has step 3 after this one.

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
GET    /tenants/:tenantId/api-keys                200 summaries, never a secret
DELETE /tenants/:tenantId/api-keys/:apiKeyId      204
```

## Things that will bite you

- **`jose` is out, `@nestjs/jwt` is in.** jose is ESM-only; Node 22 can
  `require()` it but Jest's runtime cannot, and pnpm's layout defeats
  `transformIgnorePatterns`. Do not reintroduce it without moving Jest to ESM.
- **Verify a dependency under the test runner *and* the compiled output**, not
  just under Node. Task 1.1 exists because that shortcut failed once already.
- **`isolatedModules` forbids ambient const enums.** `@node-rs/argon2`'s
  `Algorithm` is one: unit tests pass while `pnpm build` fails, because ts-jest
  transpiles without type-checking. Run the build.
- **Adding a field to a repository bundle obliges every adapter**, including the
  Postgres ones. That is how a slice of task 5.1 landed inside 4.1.
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
pnpm lint && pnpm test && pnpm test:integration && pnpm build
pnpm ops:bootstrap-operator <email>  # the first way in: creates, records, issues a token
pnpm ops:grant-operator <email>      # promotes an existing person; refuses an unknown one
```

## Conventions

- Converse with Camilo in Spanish; every repository artifact in English.
- Strict TDD: RED, GREEN, REFACTOR, VERIFY. Write the failing test first.
- Verify a guard by breaking what it guards, not by watching it pass.
- Record findings in the `## Implementation Notes` section at the bottom of
  `tasks.md`, so the next feature inherits them.
