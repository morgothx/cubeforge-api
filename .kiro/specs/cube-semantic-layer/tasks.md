# Implementation Plan — cube-semantic-layer

Ordered so that nothing waits on something that does not exist yet. The
foundation settles how the semantic layer is configured, how it fails, and where
it may be reached from; the domain group decides what a composed question and a
modelled answer are; the model itself is built in the container, which is a
separate process and therefore a separate group.

The port and its double come before the adapters, so the use case can be written
and exercised without a running semantic layer — and the model can be built
against real objects at the same time, which is what lets the two proceed
without waiting on each other.

Two tasks are the ones this feature exists to get right, and both must be shown
failing before they are believed: the tenant filter the model adds, and the
two-tenant suite that asks the same prepared question as both.

`(P)` marks a task that can run alongside its siblings.

## 1. Foundation

- [x] 1.1 Give the failure vocabulary the two words it is missing
  - A service that does not answer and a service that answers with an error are
    two different things to do about, and neither is an unreachable object store
    — an operator sent to look at storage when a container is down looks in the
    wrong place
  - Both reasons join the existing closed set rather than starting a second one,
    and both must have a producer by the time this feature is finished, which is
    the rule that set wrote for itself
  - Record in `athena-analytics-query`'s notes that a revalidation trigger
    fired, and that this feature reversed that spec's assumption about Cube
    consuming the port, and re-run that feature's suites
  - Done when both reasons are classified from a failure that produces them, a
    refusal carrying either names no location and no statement, and the previous
    feature's suites are green
  - _Requirements: 7.1, 7.3_
  - _Boundary: Integration — the analytics failure taxonomy_

- [x] 1.2 (P) Read where the semantic layer is from the environment, and refuse
      without it
  - The address, the signing secret and the deadline, read from the environment
    and never from a value written into the repository
  - Every missing setting reported together, for the reason the analytics loader
    gives: a configuration reported one key per attempt is a configuration fixed
    one attempt per afternoon
  - **A secret equal to the platform's own is refused**, because sharing one
    would let a platform access token be presented to the semantic layer
    directly — and both would verify, so the failure would be silent
  - Done when a configuration with no address is refused naming the address, a
    configuration reusing the platform's secret is refused saying so, and the
    example environment documents every setting both sides read
  - _Requirements: 8.3, 8.4_
  - _Boundary: Semantic configuration_

- [x] 1.3 (P) Point the container at the exported data, and stop publishing it
  - The container reads the analytical engine and no longer the transactional
    store — that configuration predates the export pipeline and contradicts the
    rule the pipeline exists to honour
  - It publishes nothing and starts with the development playground off: a
    semantic layer answering on a developer's machine without a credential
    contradicts the requirement that only the platform's callers are answered
  - The playground returns behind an explicit, separately named override, so
    reaching it is a decision rather than an accident
  - The example environment belongs to 1.2; this task changes the stack
    definition and nothing else, which is what keeps the two safely concurrent
  - Done when the API reaches the container by name, nothing on the host does,
    and the override brings the playground back in one command
  - _Requirements: 4.1, 4.2, 5.2, 8.4_
  - _Boundary: Compose stack_

## 2. What a question and an answer are

Pure, no infrastructure and no container. These decide what a caller may compose
and what comes back, and they are worth being able to test without either.

- [ ] 2.1 (P) Name what may be asked for, and what is offered when a name is
      wrong
  - The measures and the groupings a caller may compose from, declared once, in
    the platform's own words rather than the model's
  - An unrecognised name is refused with **every** unrecognised name listed at
    once, and with what is on offer, so a caller fixes a question rather than
    discovering it one name per attempt
  - Done when a question naming two measures that do not exist is refused naming
    both, and the refusal lists what does
  - _Requirements: 1.1, 1.7_
  - _Boundary: Semantic domain — vocabulary_

- [ ] 2.2 (P) Say what a composed question is
  - Measures, groupings, a period, and which of the two moments to read by —
    combined freely, without a definition written for the combination
  - **No tenant.** The type has nowhere to put one, which is how a caller naming
    a tenant is prevented rather than checked for
  - The period rules are the existing ones, imported rather than rewritten:
    there is no constructor for an absent period and none for one longer than
    the platform answers, which states itself when it refuses
  - A bound on how many rows one answer may carry, belonging to this design and
    not to the caller
  - Done when a question with no measure, with no period, or with a period
    beyond the limit cannot be constructed, and the limit names itself
  - _Requirements: 1.6, 2.1, 2.2, 2.3, 3.2_
  - _Boundary: Semantic domain — the question_

- [ ] 2.3 (P) Say what a modelled answer is
  - Rows, the moment they are complete through, and **where they came from** —
    what was prepared, or the exported objects read again
  - A tenant never carried out of the transactional store is a third state, not
    an empty answer: the two draw the same chart and only one means the data is
    missing
  - The three states are the analytical answer's, reproduced rather than
    borrowed — this one carries provenance that the closed port's answer has no
    reason to hold
  - Done when answered-and-empty, never-exported, and prepared-versus-read are
    four outcomes a reader can tell apart
  - _Requirements: 5.1, 5.3, 5.4, 6.3_
  - _Boundary: Semantic domain — the answer_

## 3. The seam

- [ ] 3.1 Hand out a model already bound to one tenant
  - The same shape the analytical seam has, and for the same reason stated
    there: the tenant is bound by the seam and no method below it accepts one,
    so "forgot to scope" is not expressible rather than merely refused
  - A tenant identifier that is not a plain identifier is refused before
    anything is signed, because the value is about to become a claim in a token
    and a filter in a query
  - A double that answers the same shape, for the use case to be written against
  - Done when nothing below the seam has anywhere to receive a tenant, and a
    malformed one is refused before any question is composed
  - _Requirements: 3.1, 3.2, 3.3_
  - _Boundary: Semantic port_

- [ ] 3.2 Ask the one question, for the callers allowed to ask it
  - Every member of the tenant may ask; a machine credential may not, refused on
    the kind of caller rather than on the role — an analytical question is
    expensive and admitting keys would let an automated client decide how often
    that cost is paid
  - A caller with no active membership is answered as for a tenant that does not
    exist, through the platform's existing rule
  - An answer over the bound is refused naming the bound, rather than returned
    as its first few thousand rows: a chart that is wrong without saying so is
    worse than no chart
  - Done when the three roles are answered, a key is not, and an over-bound
    answer is refused rather than trimmed — all against the double, with no
    container running
  - _Requirements: 2.4, 4.4, 4.6_
  - _Boundary: Semantic use case_

## 4. The model itself

A separate process reading files this repository writes. Nothing here imports
anything from the application, and nothing in the application imports these.

- [ ] 4.1 Reach the exported data from the container, and only ever the emulator
  - The engine is reached through a key the driver's documentation does not
    mention and its code honours, because it forwards every option it does not
    recognise — the feature rests on that, so it is asserted rather than assumed
  - An address that is not the local emulator is refused at startup, the same
    rule the TypeScript side applies, so no credential belonging to a real
    account can be used here
  - The configuration is loaded and asserted by a test that runs under this
    repository's own runner, which is what recovers the type-checking a file
    outside the project loses
  - Done when a throwaway question submitted through the container comes back
    answered from the exported objects, and a non-emulator address refuses to
    start
  - _Depends: 1.3_
  - _Requirements: 5.2, 8.4_
  - _Boundary: Cube configuration_

- [ ] 4.2 Repair the types the emulator flattens, and only where it flattens them
  - The engine reports every column as text, including one it was asked to cast,
    because the flattening is in what it says about the answer rather than in
    the answer — so nothing written in the model can repair it
  - Without the repair **nothing prepared can be read at all**: every read of a
    prepared answer ends in a sum, including a count, and a sum over text is
    refused
  - Installed for the emulator's address and for no other. This repair exists
    because of the emulator and must never teach the model to distrust a real
    engine's types — the same note the export carries about its own
  - Done when a numeric measure comes back a number rather than a string, and
    the repair is shown absent for an address that is not the emulator's
  - _Requirements: 1.2, 6.2_
  - _Boundary: Cube configuration_

- [ ] 4.3 Put the tenant into every modelled question, and refuse one that
      arrives without
  - The tenant is taken from the signed context the platform mints and turned
    into a filter no modelled question can omit
  - A context carrying no tenant is **refused**, not answered: a question that
    reads without naming a tenant is the failure this project exists to make
    impossible, and the engine's own refusal underneath it cannot be verified
    here
  - Done when a question asked with a context naming a tenant is filtered to it,
    and one asked with a context naming none does not answer
  - _Depends: 4.1_
  - _Requirements: 3.1, 3.4, 3.5_
  - _Boundary: Cube configuration_

- [ ] 4.4 (P) Define every measure and grouping once
  - Net quantity moved and the number of movements recorded; on hand as the sum
    of a product's movements, which ignores the period while the rest of the
    question keeps it — on hand is an all-time sum by definition and a question
    may not be asked unbounded
  - Groupings by either of the two days, by kind, and by the product and the
    location a movement names, each labelled by its code and its current name
    from the exported catalogue
  - The tenant is a grouping too, although the exported rows carry no such
    column: it is the partition, and the engine offers a partition as a column
  - Done when a question no definition was written for — two measures, two
    groupings, a period — comes back with numbers that match what the export
    wrote
  - _Depends: 4.1_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Boundary: Model — movements, products, locations_

- [ ] 4.5 (P) Make how far a tenant has been carried a thing the model can be
      asked
  - The export's own watermark, modelled as a cube, so an answer's completeness
    comes from the same read of the same objects as the answer
  - A tenant with no watermark is how never-exported is recognised
  - Done when the moment a tenant is complete through can be asked for on its
    own, and a tenant that has never been carried returns nothing rather than a
    default
  - _Depends: 4.1_
  - _Requirements: 5.1, 5.3, 5.5_
  - _Boundary: Model — watermarks_

- [ ] 4.6 Prepare the question the dashboard asks constantly
  - Daily totals split by kind, chosen for being asked constantly rather than
    for being cheap; every other composition falls through to the engine, which
    is correct behaviour and not a gap
  - **It carries the tenant as a grouping**, which is what confines it — the
    same act that confines a directly read answer rather than a second mechanism
    that could disagree with the first
  - It rebuilds when the export's watermark moves, with nobody asking. One
    tenant's export rebuilding the whole thing is the accepted cost of confining
    with one mechanism instead of two
  - Built through the read-only path: no write of any kind reaches the local
    engine, so the two documented strategies are unreachable here and the
    prepared answer is materialized outside the engine instead
  - Done when the prepared answer exists after a build, is used by the question
    it was prepared for, and is rebuilt without intervention once a new export
    moves the watermark
  - _Depends: 4.2, 4.4, 4.5_
  - _Requirements: 6.1, 6.4, 6.5_
  - _Boundary: Model — the prepared answer_

## 5. Reaching the model for real

- [ ] 5.1 Make the first outbound call this platform has ever made
  - A deadline covering the whole exchange rather than one attempt, because the
    semantic layer answers a slow question by saying it is still working — a
    client that reads one response and stops would report an empty answer for
    every slow question
  - Nothing is retried beyond that waiting: a refused analytical question is
    refused for a reason, and retrying it doubles the cost of every incident
  - Every failure classified where it happened — unreachable, rejected, timed
    out — with the cause travelling as a cause and never as a message, because
    an error body from a query layer routinely carries the statement it built
  - Done when a slow answer is waited for and returned, a deadline that passes
    refuses rather than hangs, and each kind of failure lands on its own reason
    with nothing disclosed
  - _Depends: 1.1, 1.2_
  - _Requirements: 7.1, 7.2, 7.4_
  - _Boundary: Cube client_

- [ ] 5.2 (P) Mint the tenant, signed, for one question
  - A short-lived context carrying the tenant the platform already authorized
    and nothing else, signed with the secret that is not the platform's
  - Minted per question rather than kept: the saving would be a signature, and a
    context outliving the question it was minted for is a credential somebody
    can replay
  - **The caller's own token is never forwarded and never in scope here**, so
    what a caller says about who they are cannot become what the model believes
  - Done when a minted context names the tenant the platform resolved, expires
    within the life of one question, and is refused by the platform's own
    verification — the two are not interchangeable
  - _Depends: 1.2_
  - _Requirements: 4.2, 4.3_
  - _Boundary: Security context_

- [ ] 5.3 Compose the question, in one file
  - The only file that builds a modelled question, which is what makes the whole
    surface a tenant could go missing from reviewable at once — the same
    property the analytics keeps by holding every statement in one place
  - The platform's names are mapped to the model's here and nowhere else, so a
    cube renamed later breaks one table rather than a dashboard
  - The completeness question is asked beside the real one in the same exchange,
    so both values come from one read of the same objects
  - The answer says where it came from, read from what the semantic layer
    reports about what it used — not inferred from how long the answer took,
    which would make the claim a claim about the instrument
  - Done when a composed question returns rows, the moment they are complete
    through, and a truthful statement of whether they were prepared or read
  - _Depends: 4.4, 4.5, 5.1, 5.2_
  - _Requirements: 1.6, 3.1, 5.1, 6.3, 6.6_
  - _Boundary: Cube model adapter_

- [ ] 5.4 (P) Build at the first question, not when the application starts
  - A missing setting refuses a modelled question; it does not refuse a boot and
    take sign-in and inventory down with it over a capability those routes never
    touch
  - A failed build is not remembered, so a setting supplied to a running process
    takes effect at the next question rather than at the next deployment
  - Done when the application starts with nothing configured, every other route
    answers, a modelled question refuses saying the capability is unavailable,
    and supplying the setting makes the next question work without a restart
  - _Depends: 1.2, 3.1_
  - _Requirements: 8.1, 8.2_
  - _Boundary: Deferred construction_

## 6. Wiring

- [ ] 6.1 Serve one route, and refuse at its edge
  - A composed question arrives as a body rather than a query string, because a
    query string encoding lists is one nobody can read in a log; nothing about
    the request changes anything
  - An unknown name, an absent period and an over-long one are all the caller's
    mistake, refused before a use case runs and long before anything is signed
  - The three tenant roles and no machines, and the analytical rate bucket the
    existing route already uses — a modelled question costs what an analytical
    one costs, and a second bucket would give one caller two budgets for the
    same expense
  - Done when the route answers a composed question for a member of the tenant,
    refuses an unknown measure naming what is offered, refuses an eleventh
    question in a minute saying how long to wait, and ignores any tenant a body
    tries to name
  - _Depends: 3.2, 5.3_
  - _Requirements: 1.7, 2.1, 2.2, 2.4, 4.1, 4.4, 4.5, 4.6_
  - _Boundary: HTTP edge_

- [ ] 6.2 Bind the feature and let a request reach it
  - This feature's port bound to its adapters in one file, so a reviewer sees
    the whole wiring of one capability at once, and imported by the application
    because a request can reach it
  - Done when the assembled application serves the route through the same
    configuration the entry point uses, and starts with the semantic layer
    absent
  - _Depends: 5.4, 6.1_
  - _Requirements: 8.1, 8.2_
  - _Boundary: Composition_

## 7. Proving the properties, not the happy path

Against the running stack and through the assembled application. Each of these
must be shown failing before it is believed.

- [ ] 7.1 Ask real composed questions of real objects
  - Combinations no definition was written for, checked against what the export
    wrote rather than against what the model says about itself
  - On hand stays the sum of a product's movements under a period that excludes
    some of them
  - Products and locations arrive labelled by code and by name; a period with
    nothing in it answers with no rows; a tenant never carried answers as such
  - The moment reported equals that tenant's watermark and is never later than
    it
  - Done when the suite computes its expectations from the exported data and
    fails if a measure, a label or the reported moment drifts from it
  - _Depends: 5.3_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 5.1, 5.3, 5.4, 5.5_
  - _Boundary: Validation — modelled questions_

- [ ] 7.2 (P) Ask the same question as two tenants, both ways
  - Two tenants, the same question, once falling through to the engine and once
    served from what was prepared — because a prepared answer is a second way to
    read and therefore a second way to leak
  - **Shown failing first**, with the tenant filter removed and again with the
    tenant dropped from what is prepared. A test that has never failed has not
    been shown to test anything, and a single-tenant version of this test passes
    whether the configuration is right or absent
  - Done when both probes are recorded as having bitten, and the suite is green
    with the model as designed
  - _Depends: 4.3, 4.6, 5.3_
  - _Requirements: 3.1, 3.4, 6.5_
  - _Boundary: Validation — isolation_

- [ ] 7.3 (P) Show that what was prepared is what answered
  - A prepared question is answered from what was prepared and says so; a
    composition nobody prepared is answered from the objects and says that
    instead
  - The prepared answer rebuilds after a new export moves the watermark, with
    nobody asking for it
  - Done when the two provenances are distinguishable in a real answer, and the
    rebuild is observed after an export rather than after a restart
  - _Depends: 4.6, 5.3_
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6_
  - _Boundary: Validation — prepared answers_

- [ ] 7.4 (P) Keep the two vocabularies in step mechanically
  - Every name the platform offers exists in the model, and every member the
    model defines is offered — the drift is a finding in both directions, since
    a measure nobody can name is as much a defect as a name nothing answers
  - Done when renaming a measure in the model fails this suite rather than a
    dashboard, months later
  - _Depends: 4.4_
  - _Requirements: 1.1, 1.7_
  - _Boundary: Validation — vocabulary_

- [ ] 7.5 Drive the whole thing through the assembled application
  - The three roles reach the route and a machine credential does not; a caller
    with no active membership is answered as for a tenant that does not exist
  - A tenant named in the body is not honoured — the path and the caller's
    standing decide, and nothing else
  - A stopped semantic layer refuses these questions only, while sign-in and
    inventory go on answering
  - A refusal carries a class of problem and nothing else: no location, no
    statement, no identifier belonging to another tenant
  - Done when the suite calls the same assembly the entry point calls, and each
    of the above is asserted where nothing else stands in front of it
  - _Depends: 6.2_
  - _Requirements: 2.4, 3.2, 3.3, 3.6, 4.4, 4.5, 4.6, 7.1, 7.2, 7.3, 7.4_
  - _Boundary: Validation — the running application_

## Implementation Notes

*Findings worth inheriting are recorded here as the work proceeds.*

### 1.1 The unit suite cannot fail on a wrong reason

The reasons are a type union and nothing else, which is this repository's idiom
and is right — but `tsconfig.json` sets `isolatedModules`, so `ts-jest`
transpiles each spec without type-checking it. The first version of this task's
test passed **before** either reason existed: `askingAs('model-unreachable', …)`
ran happily with a string the union did not contain.

So the RED here is `pnpm typecheck`, not `pnpm test`. It failed with exactly the
four expected errors and nothing else, and passed once the reasons landed. Worth
knowing for every later task in this feature: a test asserting that something is
*not* in a union is asserting nothing under `pnpm test` alone.

### 1.1 Both new reasons are still owed a producer

`model-unreachable` and `model-rejected` exist and are classified, but the only
thing raising them today is a test. That is the state this task can leave them
in — the client that raises them for real is 5.1 — and it is the exact defect
`athena-analytics-query` shipped once and its validation gate caught: a reason
nothing could emit. **5.1 is not finished until both have a producer.**

### 1.2 The secret is held to the same length as the one it must not equal

`design.md` requires only that `CUBEJS_API_SECRET` differ from
`AUTH_TOKEN_SECRET`. The loader also refuses one shorter than 32 characters,
which is what the platform's own signing secret has always been held to. A
second secret exists so a token minted for one verifier is refused by the other;
a second secret easier to guess than the first does not give that property, it
gives the appearance of it. The example environment's placeholder was replaced
to match — `docker-compose.yml` still falls back to the old short value, and
**1.3 owns bringing that default in line**.

### 1.2 The design says the container publishes nothing, and the stack cannot

`design.md` resolves requirement 4.2 by having the cube service publish no
ports, with the API reaching it "by its compose name". The API is not in compose
— it runs on the host under `pnpm start`, and so does the integration suite. A
service publishing nothing is unreachable by both.

`.env.example` therefore documents `CUBE_URL=http://localhost:4000`, and **1.3
has a decision to make rather than a line to copy**: binding the publish to
`127.0.0.1` keeps the semantic layer off the network while leaving it reachable
from the host that actually calls it, and with the development playground off
the credential remains the real defence — which is what 4.2 is a claim about.
Publishing nothing at all would make the feature untestable, which is a worse
answer to the same requirement.

### 1.3 Loopback, not silence — and what actually keeps a caller out

The design said the service publishes nothing. It cannot: the API and the
integration suite both run on the host, so nothing entitled to reach the
semantic layer would be able to. It binds to `127.0.0.1:4000` instead, and the
SQL API is not published at all because nothing uses it.

That is the right answer to 4.2 for a further reason, confirmed by probing the
running container rather than by argument. With `CUBEJS_DEV_MODE` off:

- `/cubejs-api/v1/load` with no credential answers **403, "Authorization header
  isn't set"** — before any question is parsed.
- `/playground/context` is **404**, and `/` says the server is in production
  mode. The playground, which answers without a credential, is gone.
- The same port from this machine's network address does not connect at all.

So the defence is the credential, and the binding only decides who may present
one. A port is not what 4.2 is a claim about — which is what the requirement
said, and is now measured rather than asserted.

The playground returns with
`docker compose -f docker-compose.yml -f docker-compose.playground.yml up -d cube`,
verified: ports back on every interface, `/playground/context` 200.

### 1.3 The container boots on the engine with no model, and reports itself DOWN

Expected, and worth knowing before 4.1 makes it alarming. Cube logs "There is no
cube.js file" and `/readyz` answers `{"health":"DOWN"}`, because the Athena
driver has no endpoint until `cube/cube.js` gives it one — the setting has no
documented form and cannot be passed as an environment variable. The API server
itself is up and refusing unauthorized callers throughout.

`CUBEJS_DEV_MODE: "false"` also means the container no longer starts Cube Store
on its own. That matters for 4.6 and nothing before it.
