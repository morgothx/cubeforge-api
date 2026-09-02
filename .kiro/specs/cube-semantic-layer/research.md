# Gap analysis — cube-semantic-layer

*Written 2026-09-01, against the requirements of the same date.*

Three findings below would change the shape of this feature if they were met
during implementation rather than before it. They are stated first, in full,
because the rest of this document is ordinary.

## The three findings

### 1. `queryRewrite` does not isolate what has been prepared in advance

Requirement 6.5 asks that prepared data be confined to one tenant the same way a
directly read answer is. **The obvious implementation does not do that.**

Filtering per tenant inside `queryRewrite` rewrites the *query*. What is
prepared in advance is keyed separately, by an application identity and an
orchestrator identity that default to a single shared value. Cube's own
documentation is explicit about the consequence of leaving them alone: the data
model or the data of one tenant is used for another.

So the mechanism that satisfies requirements 3.1 to 3.4 is silent about 6.5, and
the failure it produces is the one this project exists to make impossible — a
cross-tenant read, arriving through a cache rather than through a query. Worse,
it is invisible to a single-tenant test: with one tenant in the cache, every
answer is correct.

**A test for 6.5 must arrange two tenants, ask the same prepared question as
both, and confirm the second is not served the first one's rows.** Nothing less
distinguishes a correct configuration from an absent one, which is the same
shape as the isolation probes `tech.md` already requires.

### 2. Preparing an answer in advance means writing, and the emulator may not

Both documented strategies for building a pre-aggregation over Athena are
writes:

- **Batching** (the default) issues `CREATE TABLE AS SELECT` inside Athena, and
  needs `glue:CreateTable` on the pre-aggregation schema plus `s3:PutObject` on
  its location.
- **Export bucket** issues `UNLOAD` to write directly to object storage, needing
  only `s3:PutObject`.

Every question this platform has asked an engine so far has been a `SELECT`. The
emulator is DuckDB underneath, and whether it implements `CTAS` or `UNLOAD`
through the Athena API is unknown and untested here. If it implements neither,
requirement 6 cannot be verified locally by its natural means, and the design
must say so plainly and choose an arrangement that can be — not quietly ship a
suite that passes because nothing was built.

### 3. The driver may not be pointable at the emulator

The documented configuration for the Athena driver is a region and a pair of
credentials, with an optional workgroup, catalogue and output location. **No
endpoint override is documented.** Reaching the emulator therefore depends on
whether the AWS SDK bundled inside the container honours the ambient
`AWS_ENDPOINT_URL` variable — which this repository's own adapter sets
explicitly rather than relying on.

This is the one finding that could stop the feature rather than shape it. It
should be settled by an experiment against the running container **before** the
design commits to an approach, not during implementation.

## Current state

### What exists and is reusable

| Asset | Where | Why it matters here |
|---|---|---|
| Failure taxonomy | `application/analytics/analytics-failure.ts` | Five named reasons, `askingAs` for classifying at the step that knows, and the rule that every reason must have a producer. Requirement 7 needs the same closed set. |
| Failure-to-HTTP filter | `adapters/http/analytics-failure.filter.ts` | Already turns `AnalyticsUnavailable` into a response that names no location and no statement (7.4). |
| Deferred construction | `adapters/analytics/deferred-analytics.ts` | The exact mechanism requirement 8.1 asks for: built at the first question, so a missing setting refuses a question instead of a boot. A failed build is not remembered. |
| Configuration loader | `adapters/analytics/analytics-config.ts` | Reports every missing key at once, and `requireLocalEmulator` refuses a non-emulator endpoint (8.4). |
| The catalogue | `adapters/analytics/catalogue-definition.ts` | The four tables a model would be written over — `movements`, `products`, `locations`, `watermarks` — with their partitions and projection already declared. |
| The column contract | `domain/export/exported-row.ts` | Names and types the model's measures and dimensions map onto, published for exactly this. `category` was named there for this feature. |
| Role and caller resolution | `adapters/http/access/`, `principal.middleware.ts` | `@Access({ roles })` and `actorOf` give 4.4 and 4.6 with no new mechanism. |
| Throttling | `adapters/http/throttling-buckets.ts` | An `analytics-caller` bucket exists, keyed by a hash of the caller, with `everyBucketExcept` for the skip list. 4.5 extends this rather than inventing one. |
| Token issuing | `adapters/crypto/access-token-issuer.ts` | `@nestjs/jwt` on HS256, with a validated secret of a minimum length — the pattern a signed security context follows. |

### What does not exist

- **Any outbound HTTP call.** A search of `src/` and `scripts/` for `fetch`,
  `axios`, `undici` or `http.request` returns nothing. This platform has never
  called another service. The proxy of requirement 4.1 is the first, and it
  arrives with no convention behind it: no timeout policy, no test double, no
  classification of a transport failure into the failure taxonomy.
- **Any Cube configuration.** `cube/model/` holds a single `.gitkeep`. There is
  no `cube.js` configuration file, no model, and no test that reads either.
- **A model-facing question shape.** Every analytical question so far is a
  method on a closed port. A question naming measures, dimensions and a period
  has no representation in this codebase.

### Constraints the existing architecture imposes

- **`structure.md` forbids the reflex to abstract.** *"Do not create an
  interface and an injection token for a component that will only ever have one
  implementation — the Athena client is the canonical example."* A Cube client
  is that same case. It should be a plain adapter class.
- **The dependency rule is enforced by lint**, not documented. Anything the
  domain layer learns about the semantic layer fails the build.
- **The compose file publishes the semantic layer on the host** (`4000`,
  `15432`). Requirement 4.2 says a caller the platform has not authorized gets
  no answer — which today's compose contradicts on a developer's machine. The
  design must either stop publishing those ports or state that 4.2 is a claim
  about the credential rather than about the network, and test it accordingly.
- **The stack is now required for integration tests.** The semantic layer joins
  PostgreSQL and the emulator as something the suite needs running.
- **Two secrets, not one.** The security context must be signed with a secret
  that is not `AUTH_TOKEN_SECRET`. `CUBEJS_API_SECRET` already exists in
  `.env.example`. Sharing one secret would let a platform access token be
  presented to the semantic layer directly.

## Requirement-to-asset map

| Req | Rests on | Gap |
|---|---|---|
| 1 — measures and groupings | The catalogue and the column contract | **Missing:** the model itself. No existing asset expresses a measure. |
| 2 — what a question may cost | `domain/analytics/period.ts` already refuses an absent or over-long period | **Constraint:** those rules live behind a closed port. A composed question needs them applied at a new edge, and the row bound (2.3, 2.4) has no precedent at all. |
| 3 — whose records | The engine's `injected` projection, plus a rewrite in the model | **Unknown:** 3.5 is unverifiable locally, as recorded in the requirements. |
| 4 — how a question arrives | `@Access`, `actorOf`, the throttling bucket | **Missing:** the outbound client and the signed context. **Constraint:** published ports contradict 4.2. |
| 5 — how current an answer is | The `watermarks` table, already exported and catalogued | **Missing:** the model must read it; a modelled answer has no equivalent of the three-state union. |
| 6 — prepared answers | Nothing | **Missing entirely, and the highest risk.** See findings 1 and 2. |
| 7 — refusals | The failure taxonomy and its filter | **Missing:** a transport failure has no reason in the taxonomy yet. |
| 8 — configuration | `DeferredAnalytics`, the config loader, `requireLocalEmulator` | **Low.** The pattern transfers almost unchanged. |

## Implementation approaches

### Option A — extend the analytics module

Add a second adapter and a second controller inside `adapters/analytics/` and
`adapters/http/`, bound by the existing `analytics.module.ts`.

- ✅ Nothing new to wire; the failure filter and throttling apply as they are.
- ✅ Smallest diff, and a reviewer sees the whole analytical story in one module.
- ❌ `analytics.module.ts` would then bind two unrelated things: a port with an
  engine behind it, and a client of another service.
- ❌ The two have different lifecycles. The semantic layer can be down while the
  engine is fine, and one module makes that one configuration surface.

### Option B — a separate feature module

`semantic.module.ts` with its own adapter directory, config loader, controller
and failure taxonomy, importing nothing from the analytics module.

- ✅ Matches how the repository already separates capabilities, and the module
  can be lifted out whole.
- ✅ The two lifecycles stay visibly separate.
- ❌ Duplicates a failure taxonomy and a deferred-construction pattern that were
  written to be reused, which is how two dialects of the same idea start.
- ❌ Two filters catching two error types that mean the same things.

### Option C — a separate module over shared analytical vocabulary (recommended)

A new `semantic.module.ts` and `adapters/semantic/` for everything genuinely
new — the client, the model configuration, the signed context, the question
shape — while the failure taxonomy, its filter, the deferred-construction
pattern and the throttling buckets stay where they are and are used from both.
The model files themselves live in `cube/model/`, outside `src/`, because that
is what the container reads.

- ✅ New things get a new home; shared things stay shared and singular.
- ✅ The failure taxonomy grows by the one reason it is missing rather than
  being copied and diverging.
- ❌ Requires deciding, once, which of the analytics vocabulary is analytical
  and which was Athena's — a judgement Option B avoids by copying.
- ❌ Model files live outside the TypeScript project, so nothing type-checks
  them. Their correctness has to come from tests that ask real questions.

## Effort and risk

**Effort: L (1–2 weeks).** Two integrations that do not exist yet — an outbound
client and a modelled data source — plus a pre-aggregation whose local build
path is unproven, plus a two-tenant isolation suite that has to fail before it
is believed.

**Risk: High**, and concentrated rather than spread:

| Risk | Severity | Why |
|---|---|---|
| The driver cannot reach the emulator | **Blocking** | No documented endpoint override. Settle by experiment first. |
| Prepared data leaks across tenants | **Blocking** | The default configuration shares the cache; the failure is silent with one tenant. |
| The emulator cannot build a pre-aggregation | High | `CTAS` and `UNLOAD` are writes this platform has never issued. |
| Every column reported as text | Medium | The emulator reports every column as `varchar`; our adapter absorbs it with a private contract, and the driver has no such contract. Numeric measures may arrive as strings locally. |
| The outbound call has no convention | Medium | First one on the platform. Timeout, classification and doubling all decided from scratch. |
| Published ports contradict 4.2 | Low | A compose change or a scoped restatement, decided deliberately. |

## Research needed, in the order it should be answered

1. **Can the driver be pointed at the emulator at all?** One experiment against
   the running container, before the design commits. Everything else is moot if
   the answer is no.
2. **Does the emulator implement `CTAS` or `UNLOAD` through the Athena API?**
   This decides whether requirement 6 is verified locally or declared, and the
   requirements already commit the design to saying which.
3. **What must be configured for prepared data to be per-tenant**, and what does
   a two-tenant probe have to do to make a wrong configuration fail?
4. **How does the driver report a column whose type the emulator flattens?**
   Whether a measure arrives as a number or as text locally.
5. **What does a timeout look like** through the driver, given the emulator's
   asynchronous submit-and-poll, and how does it map onto requirement 7.2.
