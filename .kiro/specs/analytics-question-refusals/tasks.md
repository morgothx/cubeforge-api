# Implementation Tasks — analytics-question-refusals

Ordering follows Foundation → Core → Integration → Validation. Task N implicitly
depends on everything before it; `_Depends:_` marks only non-obvious or
cross-group dependencies. `(P)` marks a task safe to run concurrently with its
immediate peers.

## Prerequisite, owned elsewhere

**The dashboard must learn to read the blameless refusal before this feature
reaches an environment it serves.** `cubeforge-web` today reads that answer as
"this is not available", so shipping the platform first replaces one false
sentence with another. The change is a small amendment to `dashboard-analytics`
and is **not tracked here** — this spec owns neither that code nor its schedule.

Nothing below is blocked by it. The work can be built and merged in any order;
only the deployment is ordered, and task 4.1 states what to check before it.

## 1. The restriction the platform knows

- [x] 1.1 State which combinations the platform cannot compose
  - A measure that counts movements recorded before the period cannot be asked
    beside more than one grouping by day. The rule reads what the vocabulary
    already publishes about each measure and each grouping, so there is no
    second list of names to keep in step.
  - The refusal carries a sentence naming the measure, both groupings, and
    which one to drop.
  - Done when the rule's spec shows:
    - that combination unaskable, and its sentence naming all three;
    - the same measure with one day grouping, and with none, askable;
    - a measure that does not count earlier movements askable beside both day
      groupings — the rule is about the combination, not the measure;
    - a scan proving the sentence uses only words the vocabulary publishes.
  - _Requirements: 1.5, 2.1, 2.4_
  - _Boundary: The combination rules_

- [x] 1.2 Refuse such a question where a question is composed
  - Consulted once the names and the period are known, and refused exactly as
    an over-long period already is: a rejection naming the question as the part
    at fault and carrying the sentence a caller reads.
  - Refused before the model is asked, so no question is spent and nothing is
    signed.
  - Done when the composer's spec shows:
    - the measured combination refused, with the sentence intact;
    - the same question asked twice refused identically;
    - the three refusals it already makes unchanged.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 5.3_
  - _Boundary: Question composition_

## 2. An answer for a question nobody can answer

- [x] 2.1 (P) Add a refusal that blames nobody
  - A new member of the platform's closed set of domain failures, carrying no
    field — there is no part of the question to point at, and pointing at one
    would blame the caller for the platform's own limit.
  - Answered as a request that is well formed and still cannot be processed.
  - Independent of group 1: a different boundary, no shared files, and neither
    reads the other.
  - Done when:
    - the mapping's spec shows the new answer, with no field and a message
      naming nothing;
    - removing its entry from the mapping fails the build rather than falling
      through to a default.
  - _Requirements: 2.3, 3.1_
  - _Boundary: Domain failures, the HTTP mapping_

## 3. Three classes where there is one

- [x] 3.1 Report an engine that refused the question as a question that could
      not be answered
  - Classified where the refusal happens, never by reading the engine's
    wording — a rephrased library message would otherwise turn every failure
    into the wrong kind, silently.
  - The engine's body goes on travelling to the log and to nothing else.
  - Done when the transport's spec shows:
    - an error body from the engine producing the blameless refusal rather than
      an unavailable service;
    - the engine's text present in the logged cause and in no message.
  - _Requirements: 2.2, 3.1, 3.2, 3.3_
  - _Depends: 2.1_
  - _Boundary: The model transport_

- [x] 3.2 Keep an unreadable answer and a malformed watermark unavailable
  - Both become one reason of their own. The reason that covered all three
    producers is **removed rather than narrowed**: a reason nothing can emit is
    the defect this repository's own rule warns about.
  - Done when:
    - an unreadable answer and a malformed watermark both report the analytics
      unavailable, under the new reason;
    - an engine that cannot be reached is unchanged;
    - nothing in the source names the removed reason;
    - the filter that answers an unavailable service records that it no longer
      answers every analytics failure — its argument for that answer is sound
      for what remains and was never true of a question nobody can ask.
  - _Requirements: 4.1, 4.2, 4.3_
  - _Depends: 3.1_
  - _Boundary: The model transport, the failure reasons_

## 4. Prove it against the running engine

- [x] 4.1 Show the three answers, and that the engine still refuses
  - The platform's rule is only true while the engine still has the limitation
    it describes. Asking the engine directly is what turns that from an
    assumption into a test.
  - Done when, against a running stack:
    - the measured combination is refused **before the engine is asked**,
      asserted by a request count rather than by an empty answer;
    - a question naming that measure with one day grouping still answers;
    - the forbidden question put to the engine directly still comes back an
      error — this is the test that fails the day the engine gains support and
      the platform's rule becomes a lie;
    - the vocabulary route answers exactly as before;
    - no route, command or control was added.
  - Before deployment, confirm the dashboard reads the blameless refusal (see
    Prerequisite). This is a check, not a code change.
  - _Requirements: 1.1, 5.1, 5.2, 5.4_
  - _Depends: 1.2, 3.2_
  - _Boundary: Integration_

## Implementation Notes

- **1.1** — **The existing question spec asserts the premise this feature
  disproves.** `question.spec.ts` has a case combining every measure with every
  grouping and expects it to compose — which is exactly the combination 1.2
  will refuse. That test is not stale by accident; it encoded the design's old
  belief. **1.2 must change it rather than work around it**, and its comment
  should say why the belief changed.

  **The rule reads the vocabulary rather than naming anything.** Which measures
  count earlier movements and which groupings are days come from
  `MEASURE_TRAITS` and `GROUPING_SHAPES`, so the spec derives its own fixtures
  the same way. A probe replacing the trait lookup with a written-down measure
  name turns it red.

  **A scan for published words is not enough on its own.** The first version
  extracted `snake_case` tokens and required each to be published — but a
  leaked model member is `movements.net_quantity`, whose second half *is*
  published, so the leak would have passed. The shape of the leak is the dot,
  and the test now rejects it. Worth inheriting by any later refusal that
  composes a sentence.

  Seven probes bit: one day grouping refused, a bounded measure refused, the
  measure missing from the sentence, the groupings missing, no remedy offered,
  the model's naming leaked, and the rule reading a written-down list.

  Suite after 1.1: 809 tests across 92 suites, with `typecheck` and `lint`
  clean. Nothing calls the rule yet — that is 1.2.
- **1.2** — **The old belief was corrected where it was written, not worked
  around.** `question.spec.ts` asked for every measure with every grouping to
  prove the combination carried no bound, and `question.ts` said so in prose.
  Both now say what was measured instead, and the test keeps an "everything on
  offer" case with one day dropped — as far as "any with any" now reaches.

  **The refusal blames the question, not a list.** Every name in it is one the
  platform offers, so `field: 'measures'` would send a caller looking for a
  mistake that is not there. A probe swapping the field turns the spec red.

  **The ordering is enforced by the type system, not by a check.** A caller who
  names something unknown hears about that first, because the rule takes
  *resolved* names: calling it before resolution fails `typecheck` with TS2345.
  That was verified by trying it, after a probe meant to reverse the order
  turned out to be a no-op — the mutation returned `null` for want of resolved
  names and changed nothing. **The blind one was the probe, not the test.**

  Three probes bit: the rule never consulted, the refusal blaming a list, and
  the sentence written at the call site instead of in the rule. The fourth is
  replaced by the typecheck above, which is a stronger guarantee than a test.

  Suite after 1.2: 813 tests across 92 suites; `lint`, `typecheck` and `build`
  clean. No other caller of `questionFrom` composed the refused combination, so
  nothing else moved.
- **2.1** — **The filter had no spec; the design called it a modification.**
  `domain-error.filter.spec.ts` did not exist — the only coverage was through
  the access guard's own suite. It is a created file, not a modified one, and
  the design's file plan is wrong on that row. Written in the house style: a
  real Nest app and a request, not a faked `ArgumentsHost`, because the filter's
  whole job is the response and a mocked context only asserts the mock.

  **The build is the test for exhaustiveness.** Removing the mapping's case
  fails `typecheck` rather than any spec, which is the guarantee the union was
  built for. Probed that way deliberately — a runtime test could not see it.

  **A probe did not apply because its anchor was not unique:** the body shape
  `{ message: describeDomainError(error) }` appears twice, the other being
  `last-administrator`. Re-run against the case label, it bit. Anchor a probe
  on the thing it means to change, not on a line that happens to look like it.

  Four probes bit: the refusal answered `400`, a field travelling with it, the
  message naming a measure, and the mapping removed (build).

  Suite after 2.1: 817 tests across 93 suites; `lint` and `typecheck` clean.
- **3.1** — **"The engine answered with an error" was three things, not one.**
  The existing spec grouped a compile error, a refused credential and a `500`
  under one reason. Only the first is about the caller's question: the second is
  the context *this platform* signed, and the third is the engine failing.
  Mapping all three to the blameless refusal would have repeated, in a new
  place, the mislabelling this feature exists to remove.

  **Split by status, never by wording.** `refusedTheQuestion(status)` is
  `status < 500 && status !== 401 && status !== 403`. A status is a protocol
  signal; the rule this repository states forbids matching an engine's *message*,
  and that rule is kept. Probes at the exact boundary bite: `<= 500` turns a
  failing engine into a bad question, and dropping the credential exclusion
  turns our own signing error into one.

  **Boundary crossed deliberately, and recorded.** For the engine's body to
  reach an operator through the domain refusal (3.3), `DomainViolation` gained
  an optional `cause` and `DomainErrorFilter` now logs it — both files belong to
  2.1's boundary. The alternative was a logger inside the transport, which
  would have made a framework-free adapter depend on Nest for one line. The
  arrangement mirrors `AnalyticsUnavailable`, which already works this way.

  **An edge for 3.2.** `CubeClient` is also the transport for the *watermark*
  query, which the platform composes from a single member and the caller never
  sees. If the engine ever refused that one, it would now surface as a question
  nobody can answer rather than as a defect. `CubeModel` is the only place that
  knows which load is which, and `askingAs` already re-wraps anything that is
  not an `AnalyticsUnavailable` — so wrapping the watermark load is a one-line
  fix that belongs with 3.2.

  Five probes bit. Suite after 3.1: 818 tests across 93 suites; `lint` and
  `typecheck` clean.
- **3.2** — **The design said remove `model-rejected`; reality said narrow it,
  so it was narrowed.** The removal rested on "a reason nothing can emit", and
  3.1's split by status left it with producers after all: the engine answering
  an error that is *not* about the question — a refused credential, or its own
  failure. A name with a live producer is not dead vocabulary. It is kept, with
  its documentation rewritten around what it now means, and `model-unreadable`
  is added for an answer that cannot be read and a watermark that will not
  parse. **This is a deviation from `design.md`, taken knowingly.**

  **The watermark edge 3.1 flagged is closed.** `CubeModel` wraps that load in
  `askingAs('model-rejected', …)`, which re-files anything the transport raises
  about it — including the question refusal the transport would otherwise have
  produced. A query the caller never wrote cannot be their mistake. One line,
  using a mechanism that already existed.

  **An import probe cost a run.** The `askingAs` import was added by a pattern
  written for a multi-line import statement; the file had a single-line one, so
  nothing applied and 23 tests failed on an undefined function. The lesson is
  the one 2.1 recorded in another form: match the file as it is, not as the
  edit imagines it.

  Three probes bit: a garbled watermark called a question refusal, the watermark
  load left unfiled, and an unreadable answer kept under the old reason.

  **Still open:** whether a refused credential and an engine failure deserve
  separate reasons. Both are `model-rejected` today, and they send an operator
  to different places — one to how this platform signs its context, the other to
  the engine itself. Not split now; the taxonomy's own argument says it probably
  should be.

  Suite after 3.2: 820 tests across 93 suites; `lint`, `typecheck` and `build`
  clean.
- **4.1** — Measured against the running engine on 2026-10-06.

  **The engine still refuses what the platform refuses**, and the test now says
  so precisely: it asserts the cause contains *"Rolling window requires one time
  dimension"*. Matching an engine's wording is forbidden in production code and
  is the whole subject here — "it errored" would pass just as well on a query
  malformed some other way, and this test exists to notice the day *this*
  limitation goes away, not merely the day something breaks.

  **"Refused without the engine being asked" is a count.** The model is built
  over a transport that counts loads and delegates to the real client; the
  refusal arrives and the count is zero. An empty answer and an unasked question
  are indistinguishable from outside, which is why the count is the evidence.

  **Requirement 5.4 needed a scan, and the first one was too broad.**
  `analytics-controls.spec.ts` reads the controllers and holds the route surface
  to a hand-written list. Its first pass forbade `refresh` and flagged the
  authentication controller, which refreshes a *session* — a false positive, and
  the kind that gets a scan deleted rather than repaired. It now names export,
  rebuild and the engine's own `refreshPreAggregations`. **A new file the
  design's plan did not have**, the same deviation 2.1 recorded for the filter's
  spec, and for the same reason: a rule checked nowhere is a rule nobody keeps.

  Four probes bit: a rebuild control added to a controller, the route surface
  grown without being committed to, the scan pointed at no controllers, and the
  rule switched off — which turns the integration count red, proving the engine
  really is spared.

  Suite after 4.1: 823 tests across 94 suites, plus 11 integration tests against
  the running stack; `lint`, `typecheck` and `build` clean.
