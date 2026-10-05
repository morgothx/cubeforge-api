# Requirements — analytics-question-refusals

## Project Description (Input)

### Who has the problem

- **A person composing a question in the dashboard's explorer.** They choose
  three measures and five groupings — every one of them offered to them by this
  platform's own vocabulary route — and are told *"The service could not be
  reached. Please try again."* beside a retry button. Both halves are false.
  The service answered; it refused; and it will refuse identically for as long
  as the question stands. Pressing the button spends another of the ten
  questions a minute the platform allows and returns the same refusal.
- **Whoever is on call.** `model-rejected` is answered `503`, exactly as a
  semantic layer that is not running. One of those is an outage and the other
  is a question nobody can ask. An alert that cannot tell them apart sends
  somebody to inspect a container that is perfectly healthy.
- **`dashboard-analytics`, which cannot fix this on its own.** Its requirement
  9.3 makes this platform the only authority on what may be asked, and the
  vocabulary publishes no such restriction. For the dashboard to refuse the
  combination itself it would have to invent a rule the platform never stated —
  the very copy of the platform's answer that the vocabulary route exists to
  eliminate.

### Current situation

The semantic layer models `on_hand_quantity` as a rolling-window measure, and
the engine requires exactly one time dimension wherever one appears. Asked
alongside **both** day groupings, the question cannot be composed at all:

```
POST /tenants/:id/analytics/questions
{ "measures": ["on_hand_quantity"],
  "groupings": ["recorded_day", "occurred_day", "kind", "product", "location"],
  "from": "2026-09-02", "to": "2026-10-01", "by": "recorded" }

503  { "statusCode": 503, "message": "the answer is unavailable",
       "reason": "model-rejected" }
```

The engine's own words, which reach the log and never a response:

```
Error: the semantic layer refused:
{"error":"Error: Rolling window requires one time dimension and equal date ranges"}
```

Narrowed by measurement on 2026-10-01, against a provisioned tenant on a local
stack: `net_quantity` with those same five groupings answers in full;
`on_hand_quantity` with one day grouping answers; `on_hand_quantity` with
`product` and `location` answers. The refusal is specific to a cumulative
measure asked alongside both day groupings.

`analytics-failure.ts` already draws the right distinction in its own
vocabulary. `model-rejected` is documented there as *"a question the model
refused to compose"* — a property of the question — and is deliberately kept
apart from `model-unreachable`. The classification is correct; where it ends up
is not. `analytics-failure.filter.ts` answers **every** analytics failure with
`503`, and that is what reaches the person.

The over-long period is already handled the other way, and well: a `400`
carrying a sentence and a `field`, which the dashboard shows as written.

### What should change

A question the model cannot compose is refused **as a question**, in the
platform's own words, naming what the caller may change. An engine refusal the
platform did not anticipate is reported as a question that could not be
answered and nobody's mistake. `503` goes back to meaning the analytics are
genuinely unavailable.

**The decision this scope rests on** (taken 2026-10-01): the platform answers
by **fault**, in three classes rather than one. `model-rejected` already covers
two unlike things — a question that cannot be composed, which the caller can
fix, and a member the vocabulary offers that the model no longer defines, which
is a defect the caller can do nothing about. Collapsing both into "your
question was wrong" would blame a person for the platform's own drift;
collapsing both into "unavailable" is today's bug.

### Deliberately out of scope

- **The dashboard's screens, wording and composer.** `cubeforge-web` already
  shows a rejection that names the part of the question at fault as written,
  and already has blameless wording for a refusal nobody can act on. None of
  that changes.

  **One coordinated change is required of it, and is not optional** (decided
  2026-10-02): the blameless refusal of requirement 3.1 is answered `422`,
  which `cubeforge-web` today reads as "this is not available" rather than as a
  question that could not be answered. Its request layer must learn to read
  `422` before this feature reaches anybody. That change belongs to
  `dashboard-analytics`, not here; this spec owns neither its code nor its
  schedule, and must not ship to an environment the dashboard serves until it
  has landed.
- **Publishing restrictions through the vocabulary**, so a caller could refuse
  a combination before spending one of its ten questions a minute. That is
  `analytics-vocabulary`'s territory and a separate change — prevention, where
  this is the correction. The correction is needed either way, because a
  dashboard is not the only possible caller.
- **The model itself.** The rolling window is correct as modelled; nothing here
  changes what `on_hand_quantity` means.
- **When data is exported, and when a prepared answer is rebuilt.**
- **The allowance.** Whether a refused question should count against the ten a
  minute is not decided here.

---

## Requirements

### 1. A question the model cannot compose

**User story:** As a person composing a question, I want to be told that the
question itself cannot be answered and what to change about it, so that I fix
it instead of pressing a retry that cannot succeed.

#### Acceptance criteria

1.1 When a caller asks a question the Semantic Layer knows it cannot compose,
the Semantic Layer shall refuse the question and shall not report the analytics
as unavailable.

1.2 The Semantic Layer shall refuse such a question in the same terms it
refuses a period longer than it answers: as a rejection of what was asked,
carrying a sentence meant to be read and the part of the question at fault.

1.3 When the Semantic Layer refuses a question it cannot compose, it shall name
what the caller may change so that the question can be answered.

1.4 When the same question is asked again, the Semantic Layer shall refuse it
identically, so that a caller is never invited to retry a question that cannot
succeed.

1.5 The Semantic Layer shall treat a measure that counts movements recorded
before a question's period as one that cannot be asked alongside more than one
grouping by day, and shall refuse such a question under 1.1.

### 2. What a refusal may say

**User story:** As the platform, I want every refusal to be my own sentence, so
that nothing a query engine wrote about my data or my statements reaches
somebody who asked a question.

#### Acceptance criteria

2.1 The Semantic Layer shall state what is wrong in its own words, from what it
knows of its own model.

2.2 The Semantic Layer shall not include, in any answer it gives a caller, text
produced by the query engine.

2.3 The Semantic Layer shall not include, in any refusal, a statement it
generated, the location of any data, or any identifier belonging to another
tenant.

2.4 The Semantic Layer shall name, in a refusal under 1.1, only measures,
groupings and moments it already publishes as the words a question is composed
from.

### 3. A refusal the platform did not anticipate

**User story:** As a person who asked something the platform could not answer
for a reason it does not recognise, I want to be told that plainly rather than
be blamed for it or sent to wait for an outage to pass.

#### Acceptance criteria

3.1 If the query engine refuses a question for a reason the Semantic Layer does
not recognise, then the Semantic Layer shall report that the question could not
be answered and shall not present it as the caller's mistake.

3.2 If the query engine refuses a question for a reason the Semantic Layer does
not recognise, then the Semantic Layer shall not report the analytics as
unavailable.

3.3 The Semantic Layer shall record what the engine refused where an operator
can read it, and shall never place it in an answer.

### 4. What remains an unavailable service

**User story:** As whoever is on call, I want "unavailable" to mean the
analytics are actually unavailable, so that an alert sends me to something that
is really wrong.

#### Acceptance criteria

4.1 While the Semantic Layer cannot reach the query engine, it shall report the
analytics as unavailable.

4.2 If a question is accepted by the engine and then times out or fails, then
the Semantic Layer shall report the analytics as unavailable.

4.3 The Semantic Layer shall keep a question it refused, a refusal it did not
recognise, and an engine it could not reach as three distinct classes wherever
an operator reads them.

### 5. What does not change

**User story:** As a reviewer, I want the boundary of this correction to be
explicit, so that it is not read as a licence to reshape the vocabulary or the
model.

#### Acceptance criteria

5.1 The Semantic Layer shall continue to answer every question it can compose
exactly as it does today.

5.2 The Semantic Layer shall not change what any measure or grouping means, nor
which of them it offers.

5.3 The Semantic Layer shall continue to refuse a question naming something it
does not offer, and a period longer than it answers, exactly as it does today.

5.4 The Semantic Layer shall provide no way to trigger an export or a rebuild,
and shall offer no control over either.
