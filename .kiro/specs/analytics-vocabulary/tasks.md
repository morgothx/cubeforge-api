# Implementation Plan — analytics-vocabulary

The order is what makes this feature trustworthy.

1. **The declarations come first.** Every fact the route publishes must already
   be the thing the question path is built from.
2. **The question path is re-pointed at them before anything publishes them.**
   It keeps every value it has today, so the existing semantic suites, unedited,
   are the proof that nothing moved.
3. **Only then is the projection written, and the route put in front of it.**

If the route came first, it would publish facts that nothing yet enforced.

Two tasks are the ones this feature exists to get right, and both must be seen
failing before they are believed:

- **The projection's test that every published name is accepted by a
  question** (3.1).
- **The comparison of the published `cumulative` flag with what the model
  reports** (4.3).

`(P)` marks a task that can run alongside its siblings. **No integration suite is
ever `(P)`.** They share one PostgreSQL, and two running at once corrupt each
other in a way that reads as authorization failures.

## 1. Foundation

- [x] 1.1 Declare in the domain the five facts that today live elsewhere or
      nowhere
  - The moments a question may be read by, as a list the rest of the platform
    can enumerate. Today they are written twice, as a literal union and as a
    validator's list.
  - The calendar every day is counted in, beside the longest period, where days
    are already defined as UTC.
  - Whether each measure counts movements from before a question's period, for
    every measure and no other name.
  - What shape each grouping is, a day, a plain category, or an entity labelled
    by a code and a current name, and the row columns it fills. Code comes before
    name. The values are exactly the column names answers carry today.
  - Keyed exhaustively over the vocabulary's names, so a measure or grouping
    added to the tuples without a trait or a shape fails the build. Each literal
    shape is kept, so a later consumer can be typed per shape.
  - Done when the vocabulary spec pins every trait and shape, and a probe that
    adds a grouping name without a shape fails to compile. Nothing outside the
    domain consumes the new declarations yet.
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.8_
  - _Boundary: Vocabulary declarations, calendar_

- [x] 1.2 (P) Give the vocabulary an allowance of its own
  - A bucket counted per caller with the tracker the question bucket uses, so a
    person is one allowance across every tenant.
  - Its window and allowance are read from the environment and refused when not
    positive integers, like every other throttling setting. The defaults are
    sixty requests per sixty seconds.
  - It joins the platform's list of every bucket. Every existing route's skip
    list is derived from that list, so the question routes stop being counted by
    it with no edit of their own.
  - The platform refuses to start when the vocabulary allowance per second is
    not above the question allowance per second, naming both settings.
  - Record in `product.md`'s "Known gaps" that `GET /me` and the members routes
    belong to no bucket, as found while specifying this feature.
  - Done when the throttling specs show the defaults, an override, a refused
    value and a refused inversion. The buckets spec also shows the new bucket
    registered and skipped by the question route.
  - _Requirements: 4.2, 4.3_
  - _Boundary: Vocabulary throttling, throttling buckets_

## 2. Re-point the question path at the declarations

Every value stays what it is today. An assertion edited in an existing suite is a
finding to record, not a repair to make.

- [x] 2.1 Accept exactly the declared moments, and nothing else
  - The composed question and the request body both take the moment from the
    declared list, in place of their own copies.
  - Done when the edge spec shows every declared moment accepted and a value
    outside the list refused with the existing message. No other edge
    assertion changes.
  - _Requirements: 2.4, 5.1_
  - _Boundary: Integration — ModelledQuestion (domain), ModelledQuestionRequest (http)_

- [ ] 2.2 (P) Build rows and queries from the declared shapes and calendar
  - The member mapping keeps the model's member names and no platform name of
    its own. It is keyed by each grouping's declared shape, so a labelled
    grouping mapped to a single member does not compile.
  - Row keys come from the declared columns, paired with members in one place.
  - The query sent to the model states the declared calendar, which is the
    value the model used by default until now.
  - Done when the model spec shows, for every grouping and driven over the
    vocabulary rather than listed by hand, that a row's keys equal its declared
    columns, and that the query carries the declared zone. Every existing model
    assertion must pass unedited.
  - _Requirements: 2.3, 2.6, 5.2_
  - _Boundary: Member mapping, CubeModel, CubeClient_
  - _Depends: 1.1_

## 3. The published vocabulary and its route

- [ ] 3.1 Project the declarations into the published vocabulary
  - A pure value, the same for every caller and taking no tenant. It holds the
    measures with their cumulativeness, the groupings with their shapes and
    columns, the moments, the longest period and the calendar, in the order the
    declarations list them.
  - Every value is read from a declaration. None is written in the projection.
  - It carries no row bound and no display label.
  - Done when its spec shows that:
    - every published name is accepted by a composed question, and a name built
      to be absent is refused;
    - a period of the published length is accepted and one day more refused;
    - two calls are deeply equal.
  - A probe restating one name in the projection, then adding a name to the
    tuple, makes the spec fail.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1, 2.2, 2.4, 3.4, 5.3, 5.4_
  - _Boundary: Published vocabulary_

- [ ] 3.2 Admit exactly the callers a question admits, and depend on nothing
  - Its declared roles are the question route's roles, by reference rather than
    by a second list.
  - Anything that is not a tenant member is refused through the platform's
    existing rule: a machine credential, including one issued into the tenant,
    and a person acting in no tenant. Membership itself is the access guard's to
    check, before the use case runs.
  - It is constructed with no injected dependency, so nothing it could reach can
    be unavailable.
  - Done when its spec shows each tenant role answered and a machine and a
    tenantless person refused as `not-found`. It also asserts from the
    constructor's reflected parameter types that there are none, and a probe
    injecting the model port fails that assertion.
  - _Requirements: 3.1, 3.2, 4.1_
  - _Boundary: DescribeVocabularyUseCase_

- [ ] 3.3 Serve the route and put it on the platform's inventories
  - The route is `GET /tenants/:tenantId/analytics/vocabulary`. It is admitted
    with the use case's roles and no machines, counted by the vocabulary bucket
    and skipped by every other. It is wired into the semantic module beside the
    question route.
  - The route inventory and the declaration-drift check list it with the question
    route's admission.
  - Done when:
    - the controller spec shows the body equal to the published vocabulary;
    - with the model overridden by one that throws on every call, the route still
      answers `200`;
    - both inventory specs fail before the route is listed and pass after.
  - _Requirements: 1.1, 3.1, 3.2, 3.3, 4.1, 4.4_
  - _Boundary: Integration — AnalyticsVocabularyController, SemanticModule, route inventory_
  - _Depends: 1.2, 3.2_

## 4. Validation against the running stack

Every task here needs the compose stack up
(`docker compose -f cubeforge-api/docker-compose.yml up -d`), and they run one
suite at a time. Kill any leftover integration run before starting one.

- [ ] 4.1 Prove admission and sameness over HTTP
  - The route suite:
    - a member of each role receives the published body;
    - two tenants receive byte-identical bodies;
    - a stranger, a tenant that does not exist and a machine key issued into the
      tenant all receive a response byte-identical to the absent tenant's.
  - The role matrix gains the route, admitting the three roles and no machines,
    and drives each role, a key and a stranger against it.
  - Done when both suites pass alone. A probe admitting machines on the route
    turns both red.
  - _Requirements: 1.1, 3.1, 3.2, 3.3, 3.4_

- [ ] 4.2 Prove the allowance is its own, and says how long to wait
  - Spend the configured vocabulary allowance, then ask once more: `429`, with a
    positive, plain `Retry-After`.
  - With the vocabulary allowance exhausted, a question is not refused as
    throttled. With the question allowance exhausted, the vocabulary still
    answers `200`. What else the question answers is not under test, because the
    model's availability is not.
  - Done when the suite passes alone. A probe counting the route in the question
    bucket turns it red.
  - _Requirements: 4.2, 4.3, 4.4_

- [ ] 4.3 Prove the published cumulativeness is the model's
  - The vocabulary suite already reads the model's metadata, in both
    directions. For every measure, it now compares the published flag with the
    flag the metadata reports for that measure's member.
  - First, confirm that the model's metadata reports the flag at all on this
    version. If it does not, record that in the Implementation Notes, and assert
    instead the question suite's measurement: on hand counts the day before a
    one-day period, and net quantity is `null` there. Name that as the weaker
    check.
  - Done when the comparison passes for all three measures, and a probe flipping
    one measure's declared flag turns it red.
  - _Requirements: 2.5_

- [ ] 4.4 Prove nothing about questions moved
  - Run the existing semantic suites unedited, each alone: questions,
    isolation, preparation, HTTP and vocabulary.
  - Watch preparation in particular. A prepared answer must still report that it
    was prepared, now that the query states its zone. If it does not, record it as
    a finding before changing anything.
  - Then run the whole gate: lint, typecheck, the unit suite, and the integration
    suite in one run.
  - Done when every suite is green with no assertion edited outside the tasks
    that own it, and the counts are recorded in the Implementation Notes.
  - _Requirements: 2.3, 2.6, 5.1, 5.2_
  - _Depends: 2.1, 2.2, 3.3_

## Implementation Notes

*Findings worth inheriting are recorded here as tasks complete.*

- **1.1** — The declared columns, day shapes and moments were checked equal to
  `member-mapping.ts`'s current values by a one-off comparison, not kept: that
  equality becomes structural in 2.2, when the mapping reads them. Adding a
  name without a trait or shape now fails in `vocabulary.ts` itself, not only in
  the adapter's `Record`, which was the only guard before.
- **1.2** — `toEqual` ignores `undefined` array items, so "names every bucket"
  passed while `VOCABULARY_BY_CALLER` did not yet exist. It bites only once the
  constant has a value, which the left-out-of-registry probe confirmed. The
  inversion check compares cross-multiplied rates, so equal rates over
  different windows are refused. `positiveInteger` is now copied in four
  throttling loaders, following the existing one-per-loader pattern. Unifying it
  was out of this task's boundary, and it is small debt worth one refactor.
- **2.1** — A refactor has no honest RED from a new test: the edge test passes
  before the change because the values already agree. The RED was a probe on
  the unchanged code instead. With a third moment declared, the DTO's literal
  list refused it. After the change the same probe passes, and restoring a
  literal list in the DTO fails the test. The refusal message is now built from
  `READ_BY` and reads exactly as before. `READ_BY_MEMBER` still has its own
  union, left to 2.2, which owns the mapping.
