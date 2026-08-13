# Research — authentication

Discovery type: **light (extension)**. The identity records, the isolation
layers and the HTTP edge already exist; this feature adds credentials in front
of them. Research concentrated on the two dependency decisions that cannot be
reversed cheaply, and on the constraints feature 1's schema imposes on where a
password hash may live.

---

## Investigations

### 1. Where a password hash may be stored

**Finding.** It may not live on `people`. Migration 0001 grants
`SELECT` on `people` to `cubeforge_app` under the `people_app_read` policy,
which admits any person holding a membership in the current tenant. The grant is
table-wide, not column-scoped, so a `password_hash` column on `people` would be
readable by the runtime identity that serves every tenant request — and
therefore by any tenant administrator listing their members.

**Implication.** Credentials, refresh tokens and setup tokens live in their own
tables to which the tenant-scoped identity holds no grant at all. This is the
same reasoning that gave the operator no grant on `memberships`: a boundary
enforced by absent privilege rather than by careful querying.

### 2. Authentication cannot run inside a tenant transaction

**Finding.** Row-level security on tenant-owned tables keys on
`current_tenant_id()`, published per transaction. But for an API key the tenant
is *the answer*, not the question — it is learned by resolving the key. A
credential lookup therefore cannot run under the tenant-scoped identity without
a circular dependency.

**Implication.** A fourth database identity, `cubeforge_authenticator`, holds
the grants the credential tables need and no tenant context at all. It is not a
weakening of the model but an extension of it: each identity exists because its
grants differ, and this one may read secrets while `cubeforge_app` may not.

`api_keys` is the interesting case — it is tenant-owned data *and* a credential.
It carries two policies: one for the authenticator, unscoped, for resolution;
one for the tenant-scoped identity, predicated on `tenant_id`, for the
administrator who lists and revokes. The same table, two audiences, two grants.

### 3. Password hashing — build vs adopt

Verified against the registry on 2026-08-13:

| Package | Version | Install script | Notes |
|---|---|---|---|
| `argon2` | 0.45.1 | `install: node-gyp-build` | compiles when no prebuild matches |
| `bcrypt` | 6.0.0 | `install: node-gyp-build` | same, and bcrypt is the weaker KDF |
| `@node-rs/argon2` | 2.1.0 | **none** | binaries ship as optional deps per platform |
| `node:crypto` scrypt | — | — | no dependency at all |

**Decision: `@node-rs/argon2`.** Argon2id is the current recommendation, and
this package is the only Argon2 binding that needs no install script: it follows
the napi-rs pattern of shipping per-platform binaries as optional dependencies,
which is exactly the pattern already accepted for `esbuild` in
`pnpm-workspace.yaml`. Adopting `argon2` or `bcrypt` would mean granting a build
script, which the repository treats as a reviewed exception rather than a
default.

`node:crypto.scrypt` was the serious alternative — zero dependencies is hard to
argue with, and scrypt is an acceptable KDF. It was rejected because the
parameter choice would then be ours to defend, and Argon2id is what a reviewer
will expect to see.

### 4. Token format — build vs adopt

| Package | Version | Dependencies | Module format |
|---|---|---|---|
| `@nestjs/jwt` | 11.0.2 | `jsonwebtoken` | CommonJS |
| `jsonwebtoken` | 9.0.3 | `jws`, `semver`, `ms`, **seven `lodash.*` micro-packages** | CommonJS |
| `jose` | 6.2.8 | **none** | ESM only |

**Decision: `jose`.** Ten transitive dependencies, seven of them single-function
`lodash.*` packages, is precisely the surface the project's package-manager
choice exists to reduce; the npm worms of recent years travelled through exactly
that kind of package. `jose` has none.

Its ESM-only packaging was the obvious objection, so it was tested rather than
assumed:

- `require('jose')` succeeds on the installed Node 22.23. `require(esm)` has
  been unflagged since Node 22.12 for graphs without top-level await.
- The repository's `tsconfig.json` already uses `module: nodenext`,
  `moduleResolution: nodenext` and `resolvePackageJsonExports: true`, so the
  exports map resolves correctly.
- TypeScript is 5.9.3, past the 5.8 release that permits importing an ESM
  package from a CommonJS-emitting file when the target runtime supports it.

Writing our own JWS encoder was considered and rejected without much thought:
hand-rolled cryptography is the wrong thing to demonstrate.

### 5. Throttling — build vs adopt

`@nestjs/throttler` 6.5.0, first-party, peer-compatible with Nest 11. Adopted
rather than built. Note that its default storage is in-process, which is correct
for a single local instance and would need a shared store under Lambda — a
deployment concern recorded as a risk rather than solved here.

---

## Synthesis

### Generalization

Three credentials — a password, a refresh token, an API key — look like three
features but answer one question: *given a secret the caller presented, who are
they?* The design therefore defines a single principal-resolution seam with one
resolver per scheme, all producing the `ActorContext` feature 1 already consumes.
`ActorContext` gains a machine kind and nothing else changes downstream, which is
what keeps feature 3 unaffected by there being two credential types rather than
one.

A second generalization: setup tokens, refresh tokens and API keys are all
"an opaque secret, stored as a digest, with an expiry and a way to retire it".
They share one helper for generating and verifying secrets. They do not share a
table — their lifecycles and their audiences differ — so the generalization is
at the interface, not the storage.

### Build vs adopt

Adopt `@node-rs/argon2`, `jose` and `@nestjs/throttler`; build the session
lifecycle, since refresh rotation with family invalidation is a handful of rows
and a predicate, and every off-the-shelf option would bring a session model that
does not know about tenants.

### Simplification

- No session or device listing: out of scope, and the tables would exist unused.
- No separate "auth" feature module hierarchy — one `AuthenticationModule`
  beside `IdentityModule`, matching the per-feature composition already in place.
- Reuse feature 1's `DomainViolation` union rather than introducing an
  authentication error type. `not-found` and `forbidden` already collapse to one
  response, which is exactly what the disclosure rules require here too.
- The provisional actor middleware is deleted rather than adapted. Keeping a
  header-driven path behind a flag is how bypasses survive.

---

## Risks

| Risk | Consequence | Handling |
|---|---|---|
| `require(esm)` behaviour changes, or the Lambda bundler mishandles `jose` | Runtime failure at import | Task 1 imports and signs a token before anything is built on it; if it fails, `@nestjs/jwt` is the fallback and the only change is one adapter |
| In-process throttling under multiple instances | Rate limits apply per instance, so the effective limit multiplies | Documented; a shared store is a deployment concern for the serverless feature |
| Argon2 parameters too costly for a Lambda cold start | Sign-in latency | Parameters are configuration, measured during task validation rather than guessed |
| An access token remains valid for up to 15 minutes after a session is ended | A withdrawn session keeps read access briefly | Stated in requirement 5.3; authorization still resolves membership per request, so a revoked membership or a deactivated person is denied immediately |
| Operators can seize any account | Total account takeover by a privileged insider | Accepted and recorded in requirements; sessions end and the act is logged |

---

## Revalidation triggers

Re-open this design if any of these change:

- A second Node process serves requests, which makes in-process throttling wrong.
- Tokens must be verified outside this application (an API Gateway authorizer,
  another service), which turns the symmetric signing key into an asymmetric one.
- Email delivery becomes available, which makes self-service credential recovery
  possible and removes the operator bottleneck.
- Feature 3 needs a claim that the access token does not carry, which would
  reopen the decision to keep tenants and roles out of it.
