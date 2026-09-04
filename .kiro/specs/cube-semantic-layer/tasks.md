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

- [x] 2.1 (P) Name what may be asked for, and what is offered when a name is
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

- [x] 2.2 (P) Say what a composed question is
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

- [x] 2.3 (P) Say what a modelled answer is
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

- [x] 3.1 Hand out a model already bound to one tenant
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

- [x] 3.2 Ask the one question, for the callers allowed to ask it
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

- [x] 4.1 Reach the exported data from the container, and only ever the emulator
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

- [x] 4.2 Repair the types the emulator flattens, and only where it flattens them
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

- [x] 4.3 Put the tenant into every modelled question, and refuse one that
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

- [x] 4.4 (P) Define every measure and grouping once
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

- [x] 4.5 (P) Make how far a tenant has been carried a thing the model can be
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

- [x] 4.6 Prepare the question the dashboard asks constantly
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

### 2.1 A probe that changed nothing, and how it was caught

The probe for "names are matched exactly" — fold and trim before comparing —
left all six tests green. Not because the test was weak: because `prettier` had
rewrapped the line the probe was editing, so the edit silently matched nothing
and the file was never modified. Re-applied against the wrapped form, it failed
exactly one test, which is what it was supposed to do.

Two things worth carrying forward. **Read what a probe did, not just what the
suite said afterwards** — a green suite under a probe means either a weak test
or a probe that never landed, and only looking distinguishes them. And **run
probes against the formatted file**, since every source edit here goes through
`prettier` before it is asserted on.

### 2.1 The vocabulary is a list first and a union second

`role.ts` set the precedent and the reason is the same: the refusal has to say
what is on offer, and a union cannot be read at runtime. The list also makes the
suite's first assertion possible — every offered name is driven from the list
itself, so a name added to the vocabulary and not to the parser fails there
rather than at whatever asks for it first.

### 2.2 A probe that landed and still meant nothing

The fifth probe replaced one combined refusal with two sequential ones — the
edit applied, seven lines changed, and every test stayed green. Reading what it
did explained why: the first branch still handed `refuse` the real failing
groupings, so it batched exactly as before. The probe was a no-op in meaning
while being a real edit on disk.

2.1's lesson was that an edit may not land. This is the other half: an edit may
land and not express the failure it was written to stand for. Both end in a
green suite, and only reading the changed code tells them apart.

### 2.2 The period rules are imported, and that is the whole of it

`question.ts` computes nothing about days. `periodFrom` already refuses an
unbounded span and one beyond `LONGEST_PERIOD_DAYS`, naming the limit; the
question type simply requires a `Period` it cannot construct itself. Restating
either rule here would give the platform two answers to the same question, and
on the day they drift the looser one is the one that decides.

### 2.2 Both wrong lists are refused together

`measures` is validated before `groupings`, so a first draft reported only the
measures when both were wrong — the same "one name per attempt" the vocabulary
refusal was built to avoid, reintroduced one level up. Both results are now
gathered before either throws, and `field` names whichever sides were wrong
(`"measures and groupings"`), because the edge renders that field and a caller
reading only `measures` would go looking in the wrong list.

### 2.3 Two functions named the same thing, one layer apart

`neverExported` now exists in both `domain/analytics/answer.ts` and
`domain/semantic/answer.ts`. That is deliberate — the states are the same
because the data underneath is the same — but a file importing both will need
an alias, and a reader seeing the bare name has to know which layer they are
in. The alternative was a prefix on every constructor in both modules, which
would rename settled code to prevent a collision that has not happened yet.
Left as it is, recorded so the first file that hits it does not read the
collision as a mistake.

### 2.3 The empty answer and the absent tenant fail three tests together

Probes P1 and P2 each broke one direction of the same distinction, and each
took down three tests rather than one. That is the distinction being
load-bearing rather than the suite being redundant: `readerSees` is what several
tests assert through, so collapsing the two states is visible from every angle
that looks at them. A one-test failure here would have been the weaker result.

### 3.1 The file the design named, and the one I wrote

2.3 created `src/domain/semantic/answer.ts`; the design's File Structure Plan
says `modelled-answer.ts`. The name was copied from `domain/analytics/answer.ts`
out of habit — and the habit produced exactly the collision 2.3's own note
flagged as a risk. Renamed here, as a change of its own. The plan was right and
the note was writing down a problem the plan had already solved.

### 3.1 A doc comment that described the opposite of the code

`dayIn` returned `''` for a row carrying no day, and `''` falls in no period —
so the rows the comment said were kept were dropped. Caught by reading the
comment against the code rather than by a test, because no test covered a row
without a day: the behaviour was invented in passing and documented as if it
had been decided. Fixed, and the case now has a test.

The general form: a comment asserting behaviour that nothing exercises is a
claim, not documentation. If it is worth writing down it is worth a test, and
if it is not worth a test it was probably not thought through.

### 3.1 One method where the analytical port has two

`TenantAnalytics` names its two questions and says a general query interface
would be another surface to lose the tenant on. `ModelQuestions` takes a
composition instead, and that is the difference between the two features rather
than a weakening of this one: the point of a model is that nobody writes the
combination in advance. What makes it safe is that the bound travels inside
`ModelledQuestion` — which has no tenant field — rather than in the method
signature.

### 3.2 The bound is checked above the seam, and that is why the double must not trim

The over-bound refusal lives in the use case, and the only reason it is
testable is that 3.1's double returns more rows than the bound rather than
slicing to it. Had the double trimmed — the obvious, tidy-looking choice — this
check would have been green from the first run and green forever, including on
the day the real client started trimming too. The two decisions are one
decision made in two files, and neither file says so on its own.

### 3.2 A machine is refused on what it is, not on what role it holds

An API key is issued into a tenant *with a role*, so a role check admits a key
holding `viewer` — the check would pass and the property would not hold.
`tenantOf` refuses anything that is not a tenant member, which is the property
this actually needs. The probe that admitted a machine caller changed no role
list and still broke the test, which is the shape of the distinction.

### 4.1 Cube refuses a configuration key it does not know

The design said the configuration spec would require `cube.js` directly, and
that a helper could be exported from it for the spec to reach. Measured against
the running container, it cannot: Cube validates its options object strictly and
the container refused to start —

    Error: Invalid cube-server-core options: "driverOptions" is not allowed.
    "requireLocalEmulator" is not allowed

So the decisions moved to `cube/configuration.js`, a module Cube never reads,
and `cube.js` carries Cube's contract and nothing else. The spec requires the
sibling. This is the smallest change that keeps both the container and the test
working, and it was found by starting the container rather than by reasoning
about the file.

### 4.1 The undocumented key, read off the driver rather than believed

`AthenaDriver` destructures the options it knows and spreads `...restConfig`
into the object handed to `new Athena(...)`. Read in
`/cube/node_modules/@cubejs-backend/athena-driver/dist/src/AthenaDriver.js` in
the running container, then exercised: the driver built from
`driverOptions()` carries `endpoint: http://floci:4566` on its own config, and
`SELECT count(*) FROM movements` came back with 33 rows counted by the emulator
over the exported Parquet.

It came back as the **string** `"33"`, which is 4.2's whole reason for existing,
observed here as a side effect rather than taken on faith from the research.

### 4.1 A near-miss that looks correct: `floci:4566` is a valid URL

`new URL('floci:4566')` succeeds with protocol `floci:` and an empty hostname,
so it never reaches the "not a URL" refusal — the emulator check catches it
instead, because the empty string is not a permitted host. The first version of
the test asserted the wrong refusal and failed. The same trap appeared in 1.2
with `cube:4000`; it is now pinned in both places.

### 4.1 No Cube Store, no answers at all — and the compose stack was missing one

With `CUBEJS_DEV_MODE: false` the container started and then refused every
question **before reaching the engine**:

    Error: Cube Store was specified as queue/cache driver. Please set
    CUBEJS_CUBESTORE_HOST and CUBEJS_CUBESTORE_PORT variables.

Dev mode is the only thing that starts an embedded Cube Store. 1.3 turned it off
deliberately and declared a `cube-store` volume that only the embedded one would
ever have used, and the design's compose stack never named a Cube Store service
— so "dev mode off" and "a rollup is built and used" (6.x) could not both hold
as written. The queue and the cache both run on it, so its absence was not a
slow path but no path at all.

Closed by adding an explicit `cubestore` service and pointing the container at
it, keeping dev mode off. That preserves the reason 1.3 turned it off — the
playground answers without a credential — instead of trading a requirement for
convenience. The volume moved with it: it now holds the service's own data
rather than shadowing a directory the embedded store would have written.

Measured after the change: `/readyz` reports `HEALTH`; a throwaway question
submitted through the container over HTTP came back `{"throwaway_probe.how_many":
"33"}` with `dbType: athena`; the same question without a credential came back
`Authorization header isn't set`.

### 4.1 The lint rule forbids `require`, and the mechanism is still the point

`@typescript-eslint/no-require-imports` rejected the runtime require the design
asks for. Suppressing the rule would have hidden a deliberate choice behind a
disable comment; `createRequire(__filename)` does the same thing without one.
The mechanism matters — an `import` would pull a file outside the TypeScript
project into the build graph, which is the thing being avoided.

The edit also missed on its first attempt: prettier had wrapped the assignment
across two lines and the replacement targeted the single-line form. Caught by
reading the file rather than by the test suite, which stayed green because the
edit changed nothing. Third time this feature.

### 4.2 The design's mechanism does not exist, because the metadata carries nothing

The design said a driver subclass would override "the method that turns response
metadata into column types". Measured: there is nothing to convert. The
emulator's `ColumnInfo` reports `Type: "varchar"` for every column — including
one the query cast to `BIGINT` — with `Precision: 0` and `Scale: 0` on all of
them. `mapTypes` maps `field.Type`, and `field.Type` is the same string for a
count, a sum and a product name.

So the types are repaired from the **rows** instead, in an override of
`downloadQueryResults`. The requirement is unchanged; the mechanism is not the
one the design named, because the one it named has no input.

The cancellable promise the driver returns is preserved explicitly. Wrapping it
plainly would drop `.cancel`, leaving a query running on the engine after
whatever wanted it had gone away.

### 4.2 Only the type is repaired, and that is the whole fix

The values stay strings. That is not a shortfall: the Athena SDK returns every
value as `Datum.VarCharValue`, so a real engine returns strings too and Cube
relies on the declared type rather than on the value's JavaScript type. Repairing
the values as well would be a transformation with nothing asking for it.

Measured on the running engine: the stock driver reports
`kind/how_many/net` all `text`; the subclass reports `text/bigint/bigint` over
the same query, with rows `{"kind":"receipt","how_many":"27","net":"911"}`. For
`https://athena.us-east-1.amazonaws.com` the factory returns the stock class
unchanged, so there is no path on which a real engine's types are second-guessed.

### 4.2 A test that was green for the wrong reason

"Leaves alone a type the engine already reported" used `'2026-03-05'` as the
value. That is not written as a number, so the test passed whether or not the
repair consulted the reported type — and the probe that deleted that check did
not break it. The check could not fail.

Replaced with a timestamp column whose values *are* plain numbers, which is the
only shape that can tell the two apart. The probe now bites.

This is the second time in this feature that a probe landing without biting
exposed a weak test rather than a strong implementation. Two of the five probes
here needed rewriting before they meant anything: one missed the file because
prettier had rewrapped the line, and one was a no-op ternary.

### 4.3 Every cube the question touches, not the first one

`queryRewrite` receives a query, not a cube, so the filter has to be built for
each cube the query names — across measures, dimensions, segments and time
dimensions alike. Filtering only the first would leave a joined cube unfiltered,
and a join is exactly where a second tenant's rows would arrive. All four
exported datasets are partitioned by tenant, so every cube in the model carries
the dimension and every one of them can be confined the same way.

### 4.3 The claim name is duplicated across the process boundary

`TENANT_CLAIM` is `tenantId` here and must be minted under that name by 5.2.
The two cannot share a constant — one is JavaScript the container loads, the
other TypeScript the API compiles. What holds them together is the integration
suite asking a real question through a real context: a rename on one side and
not the other stops every question rather than quietly widening one, which is
the failure mode worth having.

### 4.3 Two weak tests in a row, found the same way

P4 deleted time dimensions from the cube gathering, landed, and stayed green:
the test put the time dimension on `movements`, which the measure already named,
so the distinct set never changed. Rewritten with a cube reachable *only*
through that member kind, the probe bites.

That is the same failure as 4.2's P4 and the same cause — a test whose fixture
happens to satisfy the assertion through a second path, so the assertion never
depends on the thing it names. Worth stating as a rule for the rest of this
feature: when a probe lands and nothing fails, suspect the fixture before
suspecting the probe.

### 4.3 Verified against the running engine, not only in the unit spec

With a throwaway cube over `movements` and three real exported tenants, the same
question returned 3, 1 and 1 rows under three different signed contexts, against
33 unfiltered. The resolved query carried
`{"member":"movements.tenant_id","operator":"equals","values":["…"]}`, and a
context carrying no tenant came back
`Error: a modelled question must arrive with a tenant in its security context`.

The filter restricts rows rather than merely appearing in the query, which is
the difference the counts show and the resolved query alone would not.

### 4.4 The emulator repair grew from one item to four

The design named one local repair — the column types — and said the model would
otherwise be written against Athena as it is. Building the first composed
question found three more, each measured against the running engine and each
stopping the feature outright rather than degrading it:

| What Presto writes | What the local engine has | Found by |
|---|---|---|
| `from_iso8601_timestamp(x)` | `CAST(x AS TIMESTAMP)` | Any question with a period |
| `date_add('minute', …)` for timezone | nothing — and nothing needed | Any question with a period |
| `SEQUENCE(...)` for a time series | `unnest(generate_series(...))` | `on_hand_quantity` |

All three live in a `dialectFor` subclass installed for the emulator's address
and no other, beside the type repair and for the same reason: a repair that
exists because of the emulator must never become the thing a real engine depends
on. Every substitution is also valid Athena, so none of them is a local dialect
the model would have to be written twice for.

`convertTz` refuses a non-UTC question rather than returning the field. Doing
nothing is *correct* for UTC — everything here stores, exports and asks in UTC —
but doing nothing silently for another timezone would answer with hours nobody
applied, which is the kind of wrong that looks right.

### 4.4 The tenant is in the join condition, not only in the filter

Two tenants may hold the same product code — codes are theirs, not the
platform's — so joining on the code alone would match one tenant's movement to
another's product whenever both cubes were not filtered. `queryRewrite` does
filter both, and the join carries its own confinement anyway: a join is where a
second tenant's rows would arrive, and a gate that depends on another gate is
one gate.

The same reasoning made the primary key composite. Cube requires one on a cube
that joins and uses it to deduplicate; an external identifier is unique within a
tenant and nothing promises it is unique across them, so the key is the tenant
and the identifier together rather than a source system's numbering trusted to
be globally unique.

### 4.4 Two YAML mistakes worth remembering

`sql: {CUBE}.tenant_id` is a flow mapping in YAML, not a string — the container
refused to load with `bad indentation of a mapping entry`. It needs quoting.

And an unqualified `sql: tenant_id` compiles into the primary-key expression
without a table, which DuckDB rejects as ambiguous the moment a join brings a
second `tenant_id` into scope. Every column reference in the model is qualified
with `{CUBE}` for that reason, not for tidiness.

### 4.4 Verified against the export, not only against itself

The composed question — two measures, two groupings (one reached through the
join), a period — returned per-day rows for one tenant. Asked directly of the
engine, the same tenant's totals are `receipt 16 (2 rows)` and `sale -4 (1 row)`;
the model's rows sum to exactly that. `on_hand_quantity` for a single day came
back `12` beside a `net_quantity` of `6` — the all-time sum next to the day's,
in one row, which is what requirement 1.3 asks the rolling window to do.

### 4.5 Absence arrives as an empty string, not as null — 5.3 must not miss this

A tenant nothing was ever carried for returns **one row with an empty value**,
not zero rows and not a JSON `null`:

    exported      -> [{"watermarks.complete_through": "2026-09-02 18:09:42.932"}]
    never carried -> [{"watermarks.complete_through": ""}]

An aggregate with no grouping always returns a row, and the engine's result
format cannot tell an empty string from a null. So the recognition signal for
never-exported is an empty value, and `new Date("")` is an Invalid Date — which
`answeredFrom` already refuses, so the failure would be loud rather than an
answer dated 1970. Still, 5.3 must test for the empty value explicitly rather
than rely on that guard.

### 4.5 The annotated type says `number` for a moment

Cube annotates a `max` measure as `type: number` even when the value is a
timestamp string. Nothing here reads annotations, and this is the reason not to
start: an adapter trusting the annotation would parse `2026-09-02 18:09:42.932`
as a number and get `NaN`. The same lesson `answer-shape.ts` states one layer
down — the declaration is the contract, not the engine's metadata.

### 4.5 The design's "same load" does not exist

The design says the watermark is asked "in the same load as the question, as a
second query. One round trip." Measured: posting `{"query":[q1, q2]}` is treated
as data blending and refused with `Data blending query without granularity is
not supported`, because blending merges results along a shared time dimension —
which a watermark question has no reason to have.

So the watermark is a second load, not a second query in one load. That is 5.3's
to carry, and it costs a round trip the design did not budget. Recorded here
because it was found here; the boundary is 5.3's.

### 4.5 `max`, not the single value

The export writes one watermark row per tenant today, and nothing in the objects
enforces that. `max(complete_through)` is right whether there is one row or
several, and it can never report an answer as complete through a moment later
than the export it was computed from.

### 4.6 The type repair did not reach the path that needed it most

4.2 repaired types in `downloadQueryResults`. Building a prepared answer does
not go through it: `PreAggregationLoader` calls `client.stream(...)` directly
and, if the result carries no types, `client.queryColumnTypes(sql, params)`.
Both returned text, and Cube Store answered exactly as 4.2 predicted —

    Sum not supported for Utf8 ... 'sum(Utf8)'

The repair now lives where the build actually looks. Streaming is switched off
for the emulator, because a stream hands its column types over before a row has
flowed and there is nothing to infer them from at that moment; with no stream
the loader takes the rows path and asks `queryColumnTypes`, which is overridden
to sample a hundred rows of the same question. The cost is a build held in
memory and one extra cheap query — acceptable for the emulator and only there.

The lesson is 4.2's own, arriving late: a repair verified on one path is
verified on that path. `downloadQueryResults` was the path the unit spec could
reach, and it was not the path the feature needed.

### 4.6 A stale Cube Store table survives the fix that would have prevented it

After the repair landed, the failure persisted — because Cube Store still held
the table built from the broken types, and a rebuild does not re-type an
existing table. Recreating the volume was what made the fix observable.

Worth remembering for 7.3: a prepared-answer test that has ever run against a
wrong build will keep failing against a correct one until its store is cleared.

### 4.6 Provenance is `external`, not `usedPreAggregations` — 5.3 must read the right field

The design says provenance is "read from what the semantic layer reports about
which rollups it used". Measured, `usedPreAggregations` is `null` on every
answer, prepared or not. The field that actually separates them is `external`:

| Question | external | rows |
|---|---|---|
| daily totals by kind (the prepared one) | `true` | 3 |
| the same, other tenant | `true` | 1 |
| totals by product (not prepared) | `false` | 2 |

So `servedFrom: 'prepared'` is `external === true`, and 6.3 holds through that
field. Reading `usedPreAggregations` would have made the provenance permanently
report `exported-objects` — a check that cannot fail, dressed as one that can.

The two tenants seeing different rows *through the rollup* is 6.5 measured: the
prepared rows are confined by the same filter as a directly read answer.

### 4.6 The refresh worker had to be turned on

Without `CUBEJS_REFRESH_WORKER`, Cube still *chose* the rollup for a question
and then refused — "No pre-aggregation partitions were built yet ... this API
instance wasn't set up to build pre-aggregations". Choosing and building are
separate, and only one of them was configured. Added to the compose service.

### 4.6 The rebuild, measured — and how to observe it at all

The prepared answer cannot show a rebuild when the data has not changed: the
same rows come back either way. What distinguishes them is Cube Store's table
name, whose first suffix is the content version derived from the refresh key.

    watermark 2026-09-04 01:55:41.252   ->  3 tables
    pnpm ops:export
    watermark 2026-09-04 01:58:13.696   ->  4 tables, within 20 seconds
    the new one: movements_movements_by_day_and_kind_ssnxyqfb_zj4tzhcc_1l9k9e6

Nobody asked for it. Three earlier versions correspond to the three earlier
watermark values, so the relation held every time and not only once.

The observable was worth finding: "the answer is the same" is what a correct
rebuild and a rollup that never rebuilt both look like, and a test written
against the rows would have passed under either.

### 4.6 An export with nothing to carry still moves the watermark

`pnpm ops:export` reported `0 carried, 3 up to date` and the watermark moved
anyway — the run is what the watermark records, not the rows. That is what made
the rebuild testable without inventing data, and it is worth knowing before
someone reads a moved watermark as evidence that something arrived.
