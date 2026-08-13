# Handoff — cubeforge-api

Written 2026-08-13, end of session. Receiver: the next agent session (Claude or
Codex). Read this, then `.kiro/specs/authentication/tasks.md`.

## Where things stand

- **Feature 1 `tenant-and-user-management`: complete.** 32/32 tasks, spec phase
  `implemented`.
- **Feature 2 `authentication`: 15/33 tasks.** Sections 1, 2 and 3 complete, plus
  tasks 4.1, 4.2 and 4.3.
- Último commit: `feat(authentication): refresh and end sessions`.
- Working tree clean at handoff.
- Tests: `pnpm test` 189 passing, `pnpm test:integration` 53 passing,
  `pnpm lint` and `pnpm build` clean. Last run: all green.

Camilo commits. Propose a message, never run `git commit`.

## The rule that overrides everything

No agent runs `git commit`, `git push`, or anything that creates a commit, in
either repository, ever — including when a skill suggests it. Reach a checkpoint,
summarize, propose a Conventional Commits message in English, and wait.

`/kiro-impl` autonomous mode commits per task, so it is banned. Use **manual mode,
block by block**. This was decided in an earlier session and reaffirmed.

## Next task: 4.4, manage API keys

**Read this before starting it.** 4.4 needs `apiKeys` on
`TenantScopedRepositories`, and adding a field to a bundle obliges *every*
adapter to supply it — including `PostgresTenantScopedUnitOfWork`. So a slice of
task 5.2 lands inside 4.4, exactly as a slice of 5.1 landed inside 4.1. Plan for
it rather than being surprised; note it in `tasks.md` when it happens.

What already exists:

- `ApiKeyRepository` and `ApiKeyResolvingRepository` are declared in
  `src/application/ports/api-key.repository.ts`.
- `InMemoryApiKeyStore` implements both audiences and is tested.
- The `api_keys` table, its two policies and both grants exist (migration 0006).
- `SequentialIdentifierGenerator` and `UuidIdentifierGenerator` both provide
  `apiKeyId()`.

Follow `session-lifecycle.use-case.spec.ts` for wiring; it is the closest
example. Then 4.5 (provisioning with a first administrator), and section 5.

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
