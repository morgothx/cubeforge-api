# Handoff — cubeforge-api

Written 2026-08-13, end of session. Receiver: the next agent session (Claude or
Codex). Read this, then `.kiro/specs/authentication/tasks.md`.

## Where things stand

- **Feature 1 `tenant-and-user-management`: complete.** 32/32 tasks, spec phase
  `implemented`.
- **Feature 2 `authentication`: 14/33 tasks.** Sections 1, 2 and 3 complete, plus
  tasks 4.1 and 4.2.
- Último commit: `feat(authentication): establish credentials through
  operator-issued tokens` — plus one uncommitted change, see below.
- Tests: `pnpm test` 180 passing, `pnpm test:integration` 53 passing,
  `pnpm lint` and `pnpm build` clean. Last run: all green.

## Uncommitted right now

Task 4.2 (sign-in) is finished but **not committed**. Files:

- `src/application/authentication/sign-in.use-case.ts` and its spec
- `src/adapters/crypto/argon2-password-hasher.ts` (gained `verifyAgainstDecoy`)
  and its spec
- `.kiro/specs/authentication/tasks.md` (4.2 marked, notes added)

Camilo commits. Propose a message, never run `git commit`.

## The rule that overrides everything

No agent runs `git commit`, `git push`, or anything that creates a commit, in
either repository, ever — including when a skill suggests it. Reach a checkpoint,
summarize, propose a Conventional Commits message in English, and wait.

`/kiro-impl` autonomous mode commits per task, so it is banned. Use **manual mode,
block by block**. This was decided in an earlier session and reaffirmed.

## Next task: 4.3, refresh and end sessions

Everything it needs exists. Read the task in `tasks.md`, then:

- The domain rule is already written and tested: `decideRefresh` in
  `src/domain/credential/session.ts` returns `exchange`,
  `reject`, or `reject-and-invalidate-family`. The use case orchestrates, it does
  not re-decide.
- `SessionRepository` (`src/application/ports/session.repository.ts`) already has
  `insert`, `findByDigest`, `markExchanged`, `invalidateFamily` and
  `invalidateAllForPerson`.
- The in-memory double is `InMemoryAuthenticatorUnitOfWork`. Build the test
  context with `createIdentityTestContext()` and pass `context.credentials`.
- Follow `sign-in.use-case.spec.ts` for wiring; it is the closest example.

Then 4.4 (API keys), 4.5 (provisioning with a first administrator), and on.

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
- **`FORCE ROW LEVEL SECURITY` applies to the schema owner too.** Anything the
  migration identity must read or write needs an owner policy — see migrations
  0002 and 0007.
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
