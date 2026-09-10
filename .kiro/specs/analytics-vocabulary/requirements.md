# Requirements — analytics-vocabulary

## Project Description (Input)

### Who has the problem

- **The dashboard's explorer.** `cubeforge-web` is specifying
  `dashboard-analytics`, where a person composes a question from the measures,
  groupings, period and moment to read by that the platform offers. Its
  requirements say it must offer *exactly* what the platform answers, and must
  treat the platform as the only authority on what exists and what it is called.
  Today it cannot learn either from the platform.
- **The semantic layer's claim to be a vocabulary.** `cube-semantic-layer`
  declares its words once, in `src/domain/semantic/vocabulary.ts`, precisely so
  that a consumer's contract is the platform's words and not the model's. A
  vocabulary that no caller can read is a contract that every consumer has to
  copy, and a copy falls behind without anything failing. The dashboard is the
  first consumer, and this is the first gap it found.

### Current situation

- **The vocabulary is declared and not published.** `MEASURES` and `GROUPINGS`
  reach a caller only as prose inside the refusal for an unknown name. Nothing
  answers "what may I ask?" before a question is asked.
- **What a client needs to render an answer is not in the answer either.**
  `member-mapping.ts` decides that `product` arrives as two columns,
  `product_code` and `product_name`, and that `recorded_day` is a day. A client
  that echoes the names it asked for cannot find those columns. It has to
  hard-code the mapping.
- **Two platform facts a client must know in advance are likewise private.**
  - The longest period answered, `LONGEST_PERIOD_DAYS = 366` in
    `src/domain/analytics/period.ts`. The dashboard must name it *before* asking.
  - The calendar every day is counted in, which is UTC, and the dialect refuses
    any other zone.
- **One measure behaves differently and says so only in a comment.**
  `on_hand_quantity` counts movements from before the period; the other two do
  not.

### What should change

- **A tenant member can ask the platform what it answers**, and receive, in the
  platform's own terms:
  - the measures, and for each whether it counts movements from before the
    period;
  - the groupings, and for each what kind of thing it is (a day, a plain
    category, or an entity labelled by code and name) and which columns it
    contributes to a row;
  - the moments a question may be read by;
  - the longest period answered;
  - the calendar days are counted in.
- **The answer is derived from the declarations that already exist**, not
  restated beside them. The day a measure or grouping is added to the vocabulary
  is the day it appears here, with nothing else to remember.
- **Admission matches the question route** it describes: the three tenant roles
  may ask, machine credentials may not, and anyone else receives the platform's
  one indistinguishable refusal.

The consumer's proposal for the shape is in `cubeforge-web`, at
`.kiro/specs/dashboard-analytics/design.md`, under "Upstream prerequisite — the
vocabulary route". It raises three points for this spec to accept or reject
explicitly: admission, order, and whether asking counts against the analytics
allowance of ten questions a minute. This spec owns the final shape. A
difference from the proposal is legitimate, and triggers a revalidation of the
dashboard's design.

### Deliberately out of scope

- **Changing the vocabulary.** No measure, grouping or name is added, removed
  or renamed.
- **Changing the question route or its answers.** Measures arriving as strings
  and days arriving as the engine's timestamp are known properties of that route,
  and the dashboard reads them as they are.
- **The row bound.** The over-bound refusal already names it, and publishing it
  twice would give the platform two places to say 5,000.
- **Per-tenant vocabularies.** Every tenant is offered the same words today.
- **Human-readable labels or descriptions** for measures and groupings. The
  platform's names are the terms it offers.
- **Rate limiting the reads that have none today.** `tech.md` and `CLAUDE.md`
  make rate limiting a baseline for every endpoint, and `GET /me` and the
  members routes belong to no throttling bucket. That gap was found while
  specifying this route. It is recorded here and not closed: closing it changes
  what existing routes answer, and belongs to a feature of its own.

## Decisions taken before the requirements

Each answers one of the three points the consumer raised, or a conflict found
while answering them.

1. **Admission matches the question route.** The three tenant roles may ask,
   and machine credentials may not. A vocabulary is only useful to a caller that
   may ask questions, and the question route refuses machines on the kind of
   caller, because an automated client should not decide how often an expensive
   question is paid for. Admitting machines here would make a route that
   describes questions admit callers who cannot ask one.
2. **Order is the platform's own, and stable.** The consumer preserves it, so
   it is a presentation order a person sees. Leaving it to chance would reorder
   a dashboard's choices between one release and the next.
3. **Its own allowance, not the questions' allowance.** Decided by Camilo on
   2026-09-10. Describing what may be asked costs nothing the question
   allowance exists to ration: no model and no exported data is consulted. So
   counting it there would spend a tenth of a person's minute each time the
   explorer opens. Leaving it unlimited, as `GET /me` is, would break the
   platform's rule that every endpoint is rate limited. So the route is counted
   per person, in a bucket of its own, with an allowance far above the one for
   questions.

## Requirements

The subject of every criterion is **the Semantic Layer**, meaning the
platform's answer to "what may be asked", reached by a caller over HTTP. "A
question" means a composed question sent to the existing question route, which
this feature does not change.

### 1. What the vocabulary states

**User story:** As the dashboard, I want to learn what the platform answers
before I ask anything, so that I offer a person exactly those choices and can
render the answer without a copy of the platform's internals.

#### Acceptance criteria

1.1 When a caller asks what may be asked for a tenant, the Semantic Layer shall
answer with the measures it offers and the groupings it offers, each by the name
a question uses.

1.2 The Semantic Layer shall state, for each measure, whether it counts
movements recorded before a question's period as well as those within it.

1.3 The Semantic Layer shall state, for each grouping, whether it is a day, a
plain category, or an entity labelled by a code and a current name.

1.4 The Semantic Layer shall state, for each grouping, the names under which its
values appear in a row of an answer.

1.5 Where a grouping is an entity labelled by a code and a current name, the
Semantic Layer shall state which row name carries the code and which carries the
current name.

1.6 The Semantic Layer shall state the moments a question may be read by.

1.7 The Semantic Layer shall state the longest period, in days, that a question
may cover.

1.8 The Semantic Layer shall state the calendar in which it counts days.

1.9 The Semantic Layer shall list measures, groupings and moments in one order
of its own, and shall answer every request in that same order.

### 2. What the vocabulary states is what a question accepts

**User story:** As the dashboard, I want what the vocabulary says to be exactly
what a question accepts and returns, so that a choice I offer is never refused
and a choice the platform accepts is never missing.

#### Acceptance criteria

2.1 The Semantic Layer shall list a measure or a grouping if and only if a
question accepts that name.

2.2 The Semantic Layer shall state a longest period equal to the longest period
a question accepts, so that a period of that many days is accepted and a period
one day longer is refused.

2.3 The Semantic Layer shall state, for every grouping, row names equal to the
names under which an answer to a question carries that grouping.

2.4 The Semantic Layer shall list a moment if and only if a question accepts it
as the moment to read by.

2.5 The Semantic Layer shall state, for a measure, that it counts movements from
before the period if and only if an answer to a question with that measure
counts them.

2.6 The Semantic Layer shall state the calendar in which an answer to a question
counts its days.

### 3. Who may ask

**User story:** As an operator, I want the vocabulary admitted exactly as
questions are, so that describing the questions discloses nothing the questions
themselves would not.

#### Acceptance criteria

3.1 While a person holds an active membership in a tenant, in any of the three
tenant roles, the Semantic Layer shall answer that person's request for that
tenant's vocabulary.

3.2 If the caller is a machine credential, the Semantic Layer shall refuse the
request with the platform's refusal that is indistinguishable from absence,
including for a machine credential issued into that tenant.

3.3 If the caller presents no valid credential, holds no active membership in
the tenant, or names a tenant that does not exist, the Semantic Layer shall
refuse the request with the platform's refusal that is indistinguishable from
absence.

3.4 The Semantic Layer shall answer every tenant's request with the same
vocabulary, and shall include in it no record, name, count or date drawn from any
tenant's data.

### 4. What asking costs

**User story:** As an operator, I want asking what may be asked to cost nothing
the question allowance rations, and to be limited all the same, so that the
dashboard can learn the vocabulary freely and no caller can use this route to
flood the platform.

#### Acceptance criteria

4.1 While the semantic model or the exported data cannot be reached, the
Semantic Layer shall still answer requests for the vocabulary.

4.2 The Semantic Layer shall not count a request for the vocabulary against the
allowance of questions a caller may ask, and shall not count a question against
the allowance of vocabulary requests.

4.3 The Semantic Layer shall count requests for the vocabulary per person, in
an allowance of their own that is larger than the allowance for questions.

4.4 If a person exceeds the allowance of vocabulary requests, the Semantic Layer
shall refuse further requests until the allowance renews, and shall say how
long to wait in the form an ordinary HTTP client reads.

### 5. Deliberately unchanged

Stated so that the boundary is not misread as an oversight:

5.1 The Semantic Layer shall accept exactly the measures, groupings, moments and
periods a question accepted before this feature.

5.2 The Semantic Layer shall answer and refuse questions exactly as it did
before this feature, including the form in which values arrive in an answer's
rows.

5.3 The Semantic Layer shall not state the most rows an answer may carry.

5.4 The Semantic Layer shall name measures and groupings only by the names a
question uses, and shall give them no display label and no description.
