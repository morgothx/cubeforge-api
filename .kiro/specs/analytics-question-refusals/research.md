# Research — analytics-question-refusals

## Gap analysis, 2026-10-02

Measured against the running stack on 2026-10-01 and read against the code as
it stands at `5277578`.

---

## 1. Current state

### The mechanism this feature needs already exists

**A question can already be refused as a question, from inside the use case.**
`AskModelledQuestionUseCase.refuseIfOverBound` throws:

```ts
throw new DomainViolation({
  kind: 'validation',
  field: 'question',
  detail: `would answer with more than ${MAX_ANSWER_ROWS} rows; ` +
          'narrow the period or ask for fewer groupings',
});
```

That is a `400` carrying a sentence and `field: "question"` — exactly the shape
requirements 1.2 and 1.3 describe, and exactly the one `cubeforge-web` shows
verbatim (`endpoints.ts` keeps `question` and `period` readable and reinterprets
every other rejection into a refusal that blames nobody). **No new HTTP
machinery is required for requirement 1.**

**The knowledge requirement 1.5 needs is already in the domain.**
`src/domain/semantic/vocabulary.ts` holds both halves:

```ts
MEASURE_TRAITS.on_hand_quantity = { cumulative: true }
GROUPING_SHAPES.recorded_day = { shape: 'day', column: 'recorded_day' }
GROUPING_SHAPES.occurred_day = { shape: 'day', column: 'occurred_day' }
```

So "a cumulative measure asked beside more than one grouping by day" is
expressible in the platform's own published terms, with no reference to the
engine, and testable without one.

### Where a question is composed today

`src/domain/semantic/question.ts` — `questionFrom` is documented as *"the only
way to compose one, and it refuses three things"*. The controller calls it
before the use case runs, so an unknown name or a bad period never reaches the
model, a token is never signed, and no question is spent.

**Its stated premise is the one this feature disproves.** The same file says:

> Any measures with any groupings, **with no definition written for the
> combination** — that freedom is the point of a model, and what pays for it is
> that each part carries its own bound.

Each part does carry its own bound. What the measurement showed is that the
*combination* has one too, and nothing in the platform knows it.

### How a failure becomes an answer

- `src/application/analytics/analytics-failure.ts` — a closed set of reasons
  (`not-configured`, `store-unreachable`, `store-rejected`, `model-unreachable`,
  `model-rejected`, `question-timed-out`, `question-failed`), carried by
  `AnalyticsUnavailable` with the cause kept out of the message.
- `src/adapters/http/analytics-failure.filter.ts` — maps **every** one of them
  to `503 { statusCode, message: 'the answer is unavailable', reason }`, and
  logs the cause against the request's correlation id.

The filter's own documentation argues the 503: *"500 says this request was
broken, 503 says the answer is not available right now and the same request may
work later, which is true of a timeout, an unreachable store and a setting
nobody has supplied yet."* That argument holds for the reasons it names. It does
not hold for a question that can never be composed, which is the gap.

### `model-rejected` has three producers, and they are not alike

| Where | What happened | Whose fault |
|---|---|---|
| `cube-client.askOnce` — non-ok response or `body.error` | the engine refused the composed query | the question (our case), or the model drifting from the vocabulary |
| `cube-client.askOnce` — `responseBody(await response.json())` | the engine's answer could not be read | the platform or the engine |
| `cube-model.completeThroughIn` | the watermark came back as the wrong type, or is not a moment | the platform |

Requirement 3 asks for the first to stop being an outage. Requirements 4.1–4.3
keep the other two as unavailable, and 4.3 asks that the three stay distinct
wherever an operator reads them. **This taxonomy split is the real work of the
feature**, and `analytics-failure.ts` already warns that every reason must have
a producer by the time the adapter is finished — a previous feature shipped one
nothing could emit, and the validation gate caught it.

### Conventions that constrain the design

- **Classify where it happened**, never by matching an error string afterwards:
  *"matching on those is how a rephrased library message silently turns every
  failure into the wrong kind."*
- **The engine's text never leaves the process.** It carries the statement it
  generated and the location of the data. Requirement 2.2 restates this.
- Dependency direction and layering are enforced; the domain may not reach the
  adapters.

### Blast radius in the tests

Small. `model-rejected` is asserted in three unit specs only —
`cube-client.spec.ts:176`, `cube-model.spec.ts:139`,
`analytics-failure.spec.ts` — all about the mechanism rather than the HTTP
answer. The single integration assertion of `503`
(`semantic-http.integration-spec.ts:340`) is for an **unreachable** model, which
requirement 4.1 keeps unchanged.

---

## 2. Requirements feasibility

| Requirement | Needs | Gap |
|---|---|---|
| 1.1–1.4 | refuse a known-unanswerable question as a rejection | **none mechanically** — `DomainViolation` with `field: 'question'` already does it |
| 1.5 | know that a cumulative measure cannot meet two day groupings | the rule itself; both inputs already published in `vocabulary.ts` |
| 2.1–2.4 | the platform's own sentence, naming only published words | satisfied by construction if the refusal is composed in the domain |
| 3.1–3.3 | a blameless outcome that is neither outage nor caller error | **a new answer shape**, and a split of `model-rejected` |
| 4.1–4.3 | unavailable keeps meaning unavailable; three classes stay distinct | a reason per producer, and the filter stops being one-size |
| 5.1–5.4 | nothing else changes | regression surface only |

**Complexity signal:** small algorithmic rule (1.5) plus a taxonomy and
error-mapping change (3, 4). No new data model, no new route, no dependency.

---

## 3. Implementation approaches

### Option A — Enumerate the restriction in the domain (extend `questionFrom`)

Add the combination rule to `src/domain/semantic/question.ts`, beside the three
refusals already there, reading `MEASURE_TRAITS` and `GROUPING_SHAPES`.

- ✅ Refused before a token is signed, before the engine is touched, and without
  spending one of the ten questions a minute.
- ✅ A pure domain spec proves it; no engine, no container, no fixtures.
- ✅ Consistent with the controller's existing comment that an unknown name or a
  bad period "never reaches the model".
- ✅ Leaves the rule in the one module the vocabulary route also reads, so the
  later decision to publish it (out of scope here) is cheap.
- ❌ The domain now carries a rule whose origin is the engine's capability —
  exactly what `question.ts` congratulated itself on avoiding.
- ❌ Must be kept in step with the model: if the engine later supports it, the
  platform goes on refusing until somebody notices.
- ❌ Covers only what is enumerated. Requirement 3 is still unmet.

### Option B — Recognise and translate the engine's refusal

Let the question reach the engine, and turn a recognised refusal into a
rejection.

- ✅ Covers restrictions nobody enumerated, including ones added later.
- ❌ Depends on matching the engine's wording, which this codebase names as the
  mistake that silently misclassifies failures when a library rephrases itself.
- ❌ The question is already spent and a token already signed.
- ❌ Cannot say *what to change* without reading the engine's text, and
  requirement 2.2 forbids forwarding it. The actionable sentence 1.3 asks for
  would have to be reconstructed anyway — which is Option A, done later and less
  reliably.
- ❌ Cannot distinguish "your combination is impossible" from "the model no
  longer defines a member the vocabulary offers", which is a platform defect.

### Option C — Hybrid, by fault (what the approved requirements describe)

Option A for what the platform knows, plus a split of `model-rejected` so that
an engine refusal the platform did not anticipate becomes a blameless "could not
be answered", while an unreadable body or watermark stays unavailable.

- ✅ Satisfies all four requirement areas.
- ✅ Each class ends up where its fault lies, which is 4.3's whole point.
- ❌ Two changes rather than one, in two layers (domain rule; failure taxonomy
  and its HTTP mapping).
- ❌ Requires deciding the answer shape for the blameless case — see below.

**Recommendation: Option C**, with Option A's rule as the first task, because it
is independently valuable, independently testable, and removes the only
occurrence anybody has actually hit.

---

## 4. Decisions the design must take

### 4.1 The answer shape for a blameless refusal (requirement 3.1)

Constrained by the consumer: `cubeforge-web`'s `classify` reads `400` and `409`
as rejections, anything `>= 500` as unreachable-with-retry, and everything else
as unavailable. So the blameless case must be **`400` or `409`** to reach the
dashboard's blameless wording without a change there.

- `400` with a field the dashboard does not treat as readable (for example
  `model`) → the dashboard says *"This could not be answered: it asked for
  something the platform does not offer. Nothing you did caused this."* No web
  change. The objection: `400` says "bad request" about a request that may be
  perfectly well formed.
- `409` → same dashboard outcome; "conflict" is no more accurate.
- `422` → honest HTTP, but the dashboard reads it as unavailable; **would need a
  web change**, which this spec scoped out.

**Research needed:** whether a fourth refusal shape is worth introducing to the
platform's HTTP vocabulary, or whether `400` with a distinct field is the
smallest honest answer.

### 4.2 The reasons after the split

`model-rejected` must become at least two reasons with distinct producers, since
the filter will answer them differently. Naming is the design's, but the three
producers in §1 are the natural seams. Every new reason needs a producer and a
test, by this repository's own rule.

### 4.3 Where the rule lives

`questionFrom` (domain) or the use case (application). The period and name
refusals live in the domain and run at the edge; `refuseIfOverBound` lives in
the use case because it can only run *after* the answer. The combination rule is
knowable before asking, which argues for the domain.

---

## 5. Risks and research needed

- **Other restrictions are unmeasured.** The rolling-window rule is the one
  found. Probing for more costs questions against the ten-a-minute allowance and
  an engine run each. *Research needed:* enumerate Cube 1.7.19's rules for
  rolling-window measures rather than discovering them one incident at a time.
- **The second half of the engine's sentence is unexplored.** It says *"requires
  one time dimension **and equal date ranges**"*. Only the first clause was
  tripped. The platform asks with a single period, so the second may be
  unreachable — the design should say so rather than leave it open.
- **A rule enumerated in the platform can outlive the engine's limitation**, and
  nothing would fail. A test that asks the engine the forbidden question and
  expects it to refuse would catch the day it stops being true; it costs an
  integration test against a running stack.
- **`by` (recorded or occurred) may interact** with the time-dimension count.
  Unmeasured.
- **The vocabulary stays silent either way.** Until a later spec publishes the
  restriction, every caller learns it only by being refused — which is correct
  but costs a question each time.

---

## 6. Integration surfaces touched

- `src/domain/semantic/question.ts` — the rule (Option A).
- `src/domain/semantic/vocabulary.ts` — read-only; already holds both inputs.
- `src/application/analytics/analytics-failure.ts` — the reasons.
- `src/adapters/semantic/cube-client.ts`, `cube-model.ts` — which reason each
  producer raises.
- `src/adapters/http/analytics-failure.filter.ts` — the mapping that is no
  longer one-size.
- Consumers: `cubeforge-web` needs no change under §4.1's first option. The
  vocabulary route is untouched.


---

## Design synthesis, 2026-10-02

### Decisions taken

- **Option C (hybrid), as the gap analysis recommended.** The known restriction
  is refused in the domain before the model is asked; an unanticipated engine
  refusal becomes a blameless answer; everything else stays unavailable.
- **The blameless answer is `422`** (Camilo, 2026-10-02), chosen over `400` and
  `409` on the grounds that the request is well formed, authorised and about an
  existing tenant, and neither "bad request" nor "conflict" is true of it.

  **This overturned a scope statement.** `requirements.md` had recorded that
  the dashboard needed no change, which was true only of the `400`/`409`
  options. `cubeforge-web` reads `422` as "not available" today, so its request
  layer must learn to read it first. The requirement was amended rather than
  left standing, and the ordering is recorded as a rollout constraint and a
  revalidation trigger. The web change belongs to `dashboard-analytics`.
- **`model-rejected` is removed, not narrowed.** It has three unlike producers
  today; after the split, one becomes the blameless refusal and two become
  `model-unreadable`. A reason kept without a producer is the defect this
  repository's own rule warns about.
- **The rule lives in the domain**, in a new `askable.ts` read by
  `questionFrom`, because it is knowable before asking and provable without an
  engine. The cost, recorded honestly: the domain now carries a rule whose
  origin is the engine's capability, which `question.ts` had congratulated
  itself on avoiding. The alternative — matching the engine's wording — is
  forbidden by a stronger rule in the same codebase.

### Simplifications found during the review gate

- An `Unaskable { detail }` interface was replaced by `string | null`. A
  one-field wrapper carried no meaning the function name did not already carry,
  and the gate forbids structure that exists only for hypothetical scope.
- The five spec files the testing strategy names were missing from the File
  Structure Plan. Tasks anchor to that plan, so a test file named only in prose
  is a task boundary nobody can see.

### Left open deliberately

The unmeasured restrictions, the second clause of the engine's sentence
(*"and equal date ranges"*), whether `by` interacts with the time-dimension
count, and whether a refused question should cost one of the ten a minute.
