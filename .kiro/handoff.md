# Handoff — cubeforge-api

Written 2026-08-14. Receiver: the next agent session (Claude or Codex). Read
this, then `.kiro/specs/authentication/tasks.md`.

## Where things stand

- **Feature 1 `tenant-and-user-management`: complete.** 32/32 tasks, spec phase
  `implemented`.
- **Feature 2 `authentication`: 32/33 tasks.** Sections 1 to 7 complete, and
  8.1 to 8.5 with them. Only 8.6 remains.
- Último commit: `refactor(authentication): compose the application once and
  test what runs` (task 7.1). Tasks 8.1 to 8.5 are in the working tree,
  uncommitted.
- Tests: `pnpm test` 227 passing, `pnpm test:integration` 103 passing,
  `pnpm lint` and `pnpm build` clean. Last run: all green.

Camilo commits. Propose a message, never run `git commit`.

## The rule that overrides everything

No agent runs `git commit`, `git push`, or anything that creates a commit, in
either repository, ever — including when a skill suggests it. Reach a checkpoint,
summarize, propose a Conventional Commits message in English, and wait.

`/kiro-impl` autonomous mode commits per task, so it is banned. Use **manual mode,
block by block**. This was decided in an earlier session and reaffirmed.

## Next task: 8.6, the last one

8.1 to 8.5 are done — five new integration suites, listed at the bottom of
`tasks.md` along with what each one had to be broken against to be believed.
8.6 is the one with real work left in it, because **the bootstrap gap is still
open**:

- `ops:grant-operator` refuses an address it cannot find, and no route creates a
  person without an operator — so the first person has to be inserted by the
  migration identity.
- That first operator can then never obtain a password: issuing a setup token
  requires an operator bearer token, and nothing else issues one.
- The 7.1 smoke walk only completed because a token was minted out of band with
  the application's signing key. 8.6 must close this; the likely shape is
  `grant-operator` creating the person when absent and issuing the first setup
  token, since it already holds the root of trust. Confirm the shape with Camilo
  before building it — it changes an operational script, not just a test.

Composition itself is done: `AuthenticationModule` binds the crypto ports and
the throttler, `PersistenceModule` the two units of work, `SystemModule` the
clock, identifiers and correlation middleware. The unit suite boots the real
`AppModule` through `createInMemoryApplication`, so a missing registration now
fails a test.

The routes that now exist:

```
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
pnpm ops:grant-operator <email>   # the only way to create a platform operator
```

## Conventions

- Converse with Camilo in Spanish; every repository artifact in English.
- Strict TDD: RED, GREEN, REFACTOR, VERIFY. Write the failing test first.
- Verify a guard by breaking what it guards, not by watching it pass.
- Record findings in the `## Implementation Notes` section at the bottom of
  `tasks.md`, so the next feature inherits them.
