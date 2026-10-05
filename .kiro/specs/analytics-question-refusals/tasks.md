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

- [ ] 1.2 Refuse such a question where a question is composed
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

- [ ] 2.1 (P) Add a refusal that blames nobody
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

- [ ] 3.1 Report an engine that refused the question as a question that could
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

- [ ] 3.2 Keep an unreadable answer and a malformed watermark unavailable
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

- [ ] 4.1 Show the three answers, and that the engine still refuses
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
