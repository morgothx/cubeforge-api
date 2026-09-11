# Research — analytics-vocabulary

*Discovery type: light.* This extends `cube-semantic-layer` with one read-only
route. There is no new dependency, no new infrastructure and no new data. The
question worth researching was not *how to serve a list*. It was **where each
fact the list states is declared today**, because requirement 2 demands that
what the route says is exactly what a question accepts. A fact the route has to
restate is a fact that can drift.

## Scope of discovery

1. Where each of the eight facts the route publishes is declared today.
2. How an analytics route is admitted, throttled and inventoried.
3. The consumer's proposed shape, and whether to accept it.
4. Risks.

Verified against `cubeforge-api` at `57d295c` on 2026-09-10.

---

## 1. Where each fact lives today

| Fact (requirement) | Declared in | Publishable without a copy? |
|---|---|---|
| Measure names (1.1, 2.1) | `MEASURES` in `domain/semantic/vocabulary.ts` | **Yes** |
| Grouping names (1.1, 2.1) | `GROUPINGS`, same file | **Yes** |
| Longest period (1.7, 2.2) | `LONGEST_PERIOD_DAYS` in `domain/analytics/period.ts`, the constant `periodFrom` refuses against | **Yes** |
| Order (1.9) | The order of the two tuples | **Yes** |
| Row names per grouping (1.4, 1.5, 2.3) | `GROUPING_MEMBERS[g].columns[].platform` in **`adapters/semantic/member-mapping.ts`** | **No.** A platform fact sits in an adapter, beside the model's member names |
| Shape per grouping (1.3) | Nowhere. Inferred from `timeDimension` being set, and from a grouping having two columns | **No** |
| Moments (1.6, 2.4) | Twice: `@IsIn(['recorded', 'occurred'])` on the DTO, and the literal union `'recorded' \| 'occurred'` in `question.ts` and `READ_BY_MEMBER` | **No.** Two copies already |
| Cumulative per measure (1.2, 2.5) | `rolling_window: trailing: unbounded` in `cube/model/movements.yml`, plus a comment on `MEASURES` | **No.** Only the model knows |
| Calendar (1.8, 2.6) | **Nowhere stated.** Cube's default zone is UTC. `cube/configuration.js` refuses any other zone. `period.ts` documents days as UTC | **No** |

**Finding: five of the nine facts cannot be published without a copy.** Each is
repaired the same way. The fact moves to the domain, beside the names, and
whatever uses it today reads it from there. The route then publishes what the
question path is *built from*, not a description of it, and requirement 2 holds
by construction. Tests are then a second line, not the only one.

**Finding: the calendar is decided by omission.** `loadFor` in `cube-model.ts`
sends no `timezone`, so Cube's default decides it. Publishing "UTC" from a
domain constant would be a claim nothing enforces. So the question sends its
zone explicitly, from the same constant the vocabulary publishes. A different
value would reach the dialect, which refuses anything but UTC, and the question
integration suite would fail. That makes 2.6 falsifiable.

**Finding: cumulative is a model property, and the model can be asked.** The
vocabulary integration suite already reads Cube's `/meta` to compare the
platform's names with the model's members, in both directions. Cube's metadata
reports a measure's `cumulative` flag, set for a `rolling_window` measure. The
suite can compare it with the domain's declaration for every measure. The flag's
presence in `/meta` on 1.7.19 was **to be confirmed** in the first task that
touches the suite — *and was: task 4.3 measured it present, so the fallback
below was not needed.* If it is absent, the fallback is the question suite's
existing measurement: on hand counts the day before a one-day period, and net
quantity is `null` there. That is weaker, and only a fallback.

**Finding: the row columns already have a build-time guard in one direction.**
`GROUPING_MEMBERS` is a `Record` over `GroupingName`, so a grouping added without
a mapping fails the build. Moving the columns to the domain keeps that guard, and
adds one: the adapter's record is typed by each grouping's declared shape, so a
labelled grouping mapped to one member does not compile.

---

## 2. How an analytics route is admitted, throttled and inventoried

- **Admission.** `@Access({ roles })` declares the roles, and the access guard
  resolves the caller's membership in the tenant before any handler runs. That
  guard is what refuses a non-member and an absent tenant (3.3). The use case
  then calls `tenantOf(actor)`, which refuses anything that is not a tenant
  member by kind: a machine, even one issued into the tenant, or a person acting
  in no tenant (3.2). The global `DomainErrorFilter` renders every refusal as the
  one `404`. Both are the platform's existing rules, not new ones.
  *Corrected during design review:* this finding first credited `tenantOf` with
  refusing non-members, which it does not.
- **Throttling.** A bucket is a name in `EVERY_BUCKET`, options registered in
  `platformThrottlerOptions`, a guard extending `BucketThrottlerGuard` (which
  sets the plain `Retry-After`), and `@SkipThrottle(everyBucketExcept(own))`.
  Adding a name to `EVERY_BUCKET` updates every other route's skip list, and
  that derivation is what makes 4.2 hold in both directions with no edits
  elsewhere. `throttling-buckets.spec.ts` already checks that every declared
  bucket is registered.
- **Inventory.** Three suites name every route with its admission:
  `route-inventory.spec.ts`, `declaration-drift.spec.ts` and
  `role-matrix.integration-spec.ts`. The first two fail on an unlisted route by
  design. The third drives each role, a stranger, an operator and an anonymous
  caller against it. It has no machine principal, so machine refusal is held
  elsewhere (see the design's testing strategy).
- **Module.** `SemanticModule` owns the semantic surface. The deferred seam
  reads Cube's configuration only at the first question, so wiring a route here
  does not make the API depend on Cube being configured.

**Finding: the question-throttling suite exhausts the real default allowance.**
`analytics-throttling.integration-spec.ts` reads
`loadAnalyticsThrottlingConfig(process.env)` and spends it. A vocabulary suite
can do the same with a default of sixty. Those requests touch no model, so they
are cheap enough to spend for real.

---

## 3. The consumer's proposal

`cubeforge-web/.kiro/specs/dashboard-analytics/design.md` proposes:

```json
{ "measures": [{ "name": "…", "cumulative": false }],
  "groupings": [{ "name": "…", "shape": "day|category", "column": "…" },
                { "name": "…", "shape": "labelled", "codeColumn": "…", "nameColumn": "…" }],
  "readBy": ["recorded", "occurred"],
  "longestPeriodDays": 366,
  "calendar": "UTC" }
```

**Accepted unchanged.** Every field maps to exactly one requirement in section 1,
and nothing in it is a consumer's convenience the platform would regret. The
`shape` discriminator avoids the collision `{ "name": "kind", "kind": … }` would
have produced. A labelled grouping names its two columns by role, not as a list,
because "which is the code" is 1.5. An unchanged shape means the web design needs
no revalidation.

The three open points are settled in `requirements.md` under "Decisions taken
before the requirements": admission, order, and an allowance of its own.

---

## 4. Synthesis

### Generalization

**The published vocabulary is a projection of the declarations, not a document
about them.** Every fact above becomes a domain declaration that the question
path already consumes, and `describeVocabulary()` is a pure function over them.
The design adds no mechanism to keep the two in step, because there are not two
things to keep in step.

### Build vs. adopt

Nothing to adopt. The route is a controller, a use case with no dependencies and
a pure function. The throttling reuses `BucketThrottlerGuard`. OpenAPI generation
was considered as a way to publish the vocabulary as a schema. It was rejected:
the repository publishes no OpenAPI document, and a schema would describe the
body's *types*, which is not the vocabulary's content.

### Simplification

- **No port, no adapter.** The use case needs nothing injected: the vocabulary
  is a domain value. That structural absence is what makes 4.1 true. A route
  with no path to the model cannot fail when the model is down.
- **No new module.** The controller and use case join `SemanticModule`, the
  capability they describe.
- **No caching and no ETag.** The body is a constant computed in microseconds,
  and the consumer holds it for a session.

## 5. Risks

- **Moving `columns` out of `member-mapping.ts` touches a validated feature.**
  Mitigated by the existing suites. `cube-model.spec.ts` asserts the rows, and
  `semantic-questions` asserts `product_code`/`product_name` against the running
  stack. Both must pass unchanged.
- **Sending `timezone` explicitly could change prepared answers.** A rollup's
  match can depend on the query's zone. `UTC` is Cube's default, so the prepared
  and asked zones stay equal, and `semantic-preparation` must still report
  `servedFrom: 'prepared'`. If it does not, that is the finding, and the explicit
  zone is revisited, not the assertion.
- **Cube's `/meta` may not expose `cumulative`** (section 1). There is a
  fallback, and it is weaker.
- **The sixty-per-minute default is a guess.** It is configuration, like every
  other allowance, and the load-time check keeps it above the question
  allowance.
