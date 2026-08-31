# Implementation Plan — athena-analytics-query

Ordered so that nothing waits on something that does not exist yet. The
foundation settles what the analytical side is allowed to know and how it is
configured; the domain group decides what a question and an answer are; and the
engine is reached only once there is something to ask it.

The port and its double come before both, so the use cases can be written and
exercised without an engine — and the statements that satisfy that port for real
are a separate group, which is what lets the two proceed without waiting on each
other.

`(P)` marks a task that can run alongside its siblings.

## 1. Foundation

- [x] 1.1 Let the export say how far it got
  - The export publishes, per tenant, the moment its last successful run
    finished, as a fourth dataset beside the ones it already writes
  - The moment comes from the platform clock rather than the wall, because it is
    the one value this whole feature reports and an untestable one would be
    worse than none
  - Written **after** the point reached is confirmed, never before: a run that
    dies between the two leaves a mark that is behind the data, and an answer
    that understates how current it is beats one that claims a completeness the
    data does not have
  - Record in `s3-data-export`'s notes that a revalidation trigger fired, and
    re-run that feature's suites — this is a change to a spec already validated
  - Done when a tenant that has been carried has a mark a reader can find, a
    tenant that never has does not, and the previous feature's suites are green
  - _Requirements: 3.1, 3.3_
  - _Boundary: Integration — the export's published data_

- [x] 1.2 (P) Read the analytical destination from the environment, and refuse
      without it
  - Catalogue, workgroup, result location, endpoint, region and credentials,
    read from the environment and never from a value written into the repository
  - Every missing setting reported together, because a configuration reported
    one key per attempt is a configuration fixed one attempt per afternoon
  - The refusal that keeps this project off a real account moves to one place
    both features share rather than being written twice
  - Done when a configuration with no catalogue is refused naming the catalogue,
    the example environment documents every setting the analytics reads, and the
    export's own refusal still behaves exactly as it did
  - _Requirements: 7.1, 7.2, 7.3_
  - _Boundary: Analytics configuration_

- [x] 1.3 (P) Take on the two clients, and reach the emulator with them
  - The query client and the catalogue client, added as reviewed dependencies
  - Done when a throwaway question submitted through the client comes back
    answered, from a test that runs under the repository's own build
  - _Requirements: 6.1_
  - _Boundary: Dependencies_

## 2. What a question and an answer are

Pure, no infrastructure. These decide what a caller may ask for and what they
get back, and they are worth being able to test without an engine.

- [x] 2.1 (P) Name a day, a period, and what is too much
  - A period covering both of its ends, so a caller asking for one day names it
    twice and means it
  - A period that ends before it starts is unrepresentable, and there is no way
    to express one with no end at all — which is how an unbounded question is
    prevented rather than checked for
  - The longest span answerable in one question is named, and refusing says what
    it is
  - Done when the refusals are exercised in isolation and a caller cannot
    construct a period the engine would be asked to scan without bound
  - _Requirements: 1.4, 1.5_
  - _Boundary: Analytics domain_

- [x] 2.2 (P) Say what an answer is
  - Entries, plus the moment through which they are complete; or a tenant that
    has never been carried out of the transactional database
  - A period with nothing in it is an answer, not a refusal
  - Done when a tenant with no activity and a tenant never exported are
    distinguishable from each other, and neither is mistaken for a failure
  - _Requirements: 3.1, 3.3, 4.2_
  - _Boundary: Analytics domain_

- [x] 2.3 (P) Turn what the engine sends into what a reader needs
  - Every value arrives as text, whichever engine sent it; the declaration
    decides what each one becomes
  - A declared column the answer does not carry is refused loudly rather than
    read as absent
  - Done when a number, a moment and a day come back as such, and a version that
    types the result from the engine's own metadata instead is shown to produce
    text for every column against the local engine
  - _Requirements: 4.1_
  - _Boundary: Analytics domain_

## 3. The seams

- [x] 3.1 Declare what the analytical store must offer, and how it fails
  - The two questions, with the tenant bound when the seam hands the object over
    and absent from every method — so a question naming a tenant is not
    expressible rather than merely refused
  - The closed set of reasons a question can fail for, classified where the
    failure happens rather than read back out of a message afterwards
  - Done when the use cases can be written against this and nothing in the
    application layer mentions a statement, a catalogue or a page
  - _Depends: 2.1, 2.2_
  - _Requirements: 1.6, 2.2, 2.5, 6.3_
  - _Boundary: Application ports_

- [x] 3.2 Provide the double the use-case tests run against
  - Answers, empty answers, a tenant never carried, and each failure reason
    available on demand
  - It refuses a tenant identifier the real seam would refuse, because a double
    looser than the thing it stands for hides the bug it exists to catch
  - Done when a use case can be exercised end to end with no engine and no
    emulator running
  - _Depends: 3.1_
  - _Requirements: 2.5, 3.3_
  - _Boundary: In-memory adapters_

## 4. Reaching the engine for real

- [x] 4.1 Submit a question, wait for it, and read all of it
  - Submitted, then polled until answered or a deadline passes; a question that
    outlives its deadline is **stopped**, not abandoned, because work nobody is
    waiting for still costs something where this runs for real
  - Every page followed until none names another. A result arrives in pages in a
    real deployment and in one page locally, so a runner that read the first
    page would answer a busy month with part of it and no error
  - A refusal classified by what came back, so a rejected credential and an
    absent destination are different diagnoses
  - Done when a result spanning more than one page comes back whole against a
    fabricated page boundary, and a question that outlives its deadline is
    stopped and reported as timed out
  - _Depends: 1.3_
  - _Requirements: 6.1, 6.2_
  - _Boundary: Analytics adapters_

- [x] 4.2 Describe the exported layout to the engine, and give the operator a
      command
  - The four tables over the four prefixes, with the columns the export already
    publishes and nothing renamed on the way through
  - The partition arrangement, with the tenant as the injected kind so that a
    question not naming a tenant fails at the engine itself
  - Running the command twice is safe, because an operator will
  - The place the engine writes its results has to exist before the first
    question is asked, and nothing else creates it — so this command does
  - The suite needs objects to point the tables at, so it arranges them the way
    the export's own suites do: seed a tenant, run an export, then ask
  - Done when the command creates the tables against the local stack and a
    question over them answers from objects the export actually wrote. **The
    arrangement is asserted as the values the command sends**, not as engine
    behaviour: the local engine needs none of it and would answer either way
  - _Depends: 1.2, 1.3_
  - _Requirements: 3.5_
  - _Boundary: Analytics adapters_

- [x] 4.3 Bind the tenant, read the mark, and answer what moved
  - The real seam behind the port: one file holding every statement, so the
    dialect surface is reviewable in one place
  - The tenant refused unless it is a plain identifier, the same check applied
    before a tenant becomes a path segment, and for the same reason — this is
    the one way a tenant reaches a statement
  - An explicit order on every statement, and the tenant's mark read for every
    answer, so an answer knows how far it reaches
  - Done when two tenants holding the same product get their own daily numbers
    from objects the export actually wrote, and a version with the tenant
    removed from the statement is shown to return the other tenant's rows
  - _Depends: 1.1, 3.1, 4.1, 4.2_
  - _Requirements: 1.2, 2.1, 2.4, 3.1, 3.2, 4.3_
  - _Boundary: Analytics adapters_

- [x] 4.4 Answer what is on hand, named rather than only coded
  - The second statement, in the same file, joining the catalogue so a reader
    gets the product's current name beside its code
  - Not parallel with the task before it despite being a separate question: both
    statements live in one file, deliberately, and two tasks editing it at once
    is the kind of overlap this plan exists to avoid
  - Done when a tenant's on-hand total matches what its movements sum to, each
    entry carries the name the catalogue currently holds, and a product renamed
    since the last export reads with its new name
  - _Depends: 4.3_
  - _Requirements: 1.1, 1.3_
  - _Boundary: Analytics adapters_

## 5. The questions themselves

- [x] 5.1 (P) Answer what is on hand
  - Admitted to administrators, editors and viewers alike
  - Done when a tenant with movements across two products gets both, each named,
    and a tenant that has never been carried is reported as such rather than as
    having nothing
  - _Depends: 3.2_
  - _Requirements: 1.1, 1.3, 3.3, 5.2_
  - _Boundary: Analytics use cases_

- [x] 5.2 (P) Answer what moved, day by day
  - The period comes from the caller, and a question without one or with one too
    long never reaches the engine
  - Done when a period holding three days of activity yields three days, and a
    period holding none yields an answer with no entries rather than a refusal
  - _Depends: 2.1, 3.2_
  - _Requirements: 1.2, 4.2, 5.2_
  - _Boundary: Analytics use cases_

## 6. Wiring

- [x] 6.1 Give the caller a route, and the application a module
  - Bind the ports to the adapters; import the feature into the application —
    this one **is** reachable by a request, unlike the export's
  - The tenant comes from the path, the same place every other tenant-scoped
    request takes it; the period is validated before anything is read; and one
    caller is limited in how often they may ask
  - The configuration is read at the first question rather than at startup: the
    requirement is that the analytics refuses to *answer*, and an API refusing
    to *boot* would take every other route down with it
  - Done when the route answers for a member of the tenant against the local
    stack, and the API still starts with no analytical configuration present at
    all
  - _Depends: 4.4, 5.2_
  - _Requirements: 5.1, 5.4, 5.5, 7.1_
  - _Boundary: Integration — module and inbound edge_

## 7. Proving the properties, not the happy path

Each writes its own spec file. Three tasks appending to one file are not
parallel however unrelated their assertions are.

- [x] 7.1 (P) Show that no tenant reaches another's numbers
  - Two tenants holding the same product and the same location, so nothing but
    the tenant tells their rows apart and a leak shows up as the other's number
  - What each tenant is told, compared against what the export wrote for that
    tenant rather than against a list this test invented
  - Nothing identifying a person appears in any answer
  - Done when it passes with the tenant bound and fails with it removed from the
    statement
  - _Depends: 6.1_
  - _Requirements: 2.1, 2.3, 2.4, 4.4_
  - _Boundary: Integration suite_

- [x] 7.2 (P) Show that an answer can be drawn without repair
  - Quantities as numbers and moments as moments, from the real engine over real
    objects
  - The same question asked twice returns its entries in the same order
  - A period with no activity answers with no entries; a tenant never carried
    answers as never carried
  - Every answer carries the moment it is complete through, and that moment
    moves when the export runs again
  - Done when every assertion above holds against the emulator, and a version
    reporting a default moment instead of "never carried" fails it
  - _Depends: 6.1_
  - _Requirements: 3.1, 3.2, 4.1, 4.2, 4.3_
  - _Boundary: Integration suite_

- [x] 7.3 (P) Show what the route does when it cannot answer
  - The three roles may ask; a caller with no active membership is answered
    exactly as for a tenant that does not exist
  - An unreachable store reports the answer unavailable **and the transactional
    database is not consulted**, asserted rather than reasoned about
  - A failure names a class of problem and carries no statement, no location and
    no credential, filed against the request's correlation identifier
  - Done when the whole thing fails if a failure is allowed to repeat what the
    engine said
  - _Depends: 6.1_
  - _Requirements: 2.5, 3.4, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4_
  - _Boundary: Integration suite_

## Implementation Notes

*Findings worth inheriting are recorded here as the work proceeds.*

### 1.1 The upstream suite did exactly what it was written to do

`export-isolation` asserts that nothing lands outside the datasets it knows
about, and its own comment said why: "a fourth dataset appearing is exactly the
kind of thing a per-tenant sweep would never see." A fourth dataset appeared,
and it failed. The guarded set and the published-columns contract were widened
deliberately, which is a different act from a test being repaired to stop
complaining.

### 1.1 A test of mine passed for the wrong reason, and a probe said so

"The mark still says the same thing after a quiet run" passes against an
implementation that never writes it again — the first run's mark is simply still
sitting there. The probe that moves the write to the carried-only path walked
straight through it.

Fixed by advancing the test clock between the two runs, so the assertion is that
the mark **moved**, not that it exists. `FixedClock` already had `advanceTo`;
the test just was not using it.

That the mark moves on a quiet run is the whole point: a run finding nothing new
still proves the data is complete as of now, and one that only advanced when
something was carried would freeze for a quiet tenant while its answers stayed
perfectly current — the same shape as the horizon bug in the previous feature.

### 1.1 The module needed a clock it never had

`ExportModule` is booted on its own by the command, with no `AppModule` above
it, so `SystemModule` being `@Global` published nothing to it. It imports it
now. A module that is deliberately outside the application graph inherits
nothing from the application graph, which is obvious once written down and was
not before.

### Before starting: what no local test will settle

Three claims in this plan are written for an engine the local one only imitates,
and `design.md` says so at length. They are repeated here because they are easy
to forget while a suite is green:

1. **The partition arrangement** (4.2). The local engine infers partitions from
   the key path and needs none of it, so it answers whether the arrangement is
   right or wrong. The assertion is on what the command *sends*.
2. **The injected refusal** (4.2). That a question without a tenant fails at the
   engine has no local probe. The tenant bound by the seam (4.3) is the layer
   that actually holds, and nothing in this plan relies on the other.
3. **Every statement's dialect** (4.3). What runs locally is not what will run
   in a deployment. Hence one file, and constructs both engines accept.

A fourth, outside the code entirely: **no call this feature makes is authorized
locally.** The permissions a real deployment needs are listed in `design.md`
under Out of boundary, so that work starts from an inventory rather than from a
stack trace.

### 1.2 A shared refusal needs a probe that removes it, not one that bends it

Relaxing the shared host list for one host broke only the analytics test — each
feature's test names its own endpoint, so a partial relaxation is caught by
whichever test uses that host. The probe that means something for a check with
two callers is removing it entirely, and that one fails **both**: the export's
refusal and the analytics'.

Worth keeping in mind for anything else that moves out to be shared. A test per
caller proves the caller wired it up; only removing the shared thing proves the
callers depend on it.

### 1.2 Where the setting is read is part of the requirement

The export reads its configuration when its module is built, which is right for
a command: nothing else is running, and refusing early costs nothing. The
analytics must not, and the requirement says why — it refuses to *answer*. An
API that refused to *boot* over a setting one route uses would take every other
route down with it, which is the same trap the export's validation gate found
from the other side.

The loader is written so either is possible; the caller decides. Task 6.1 is
where that decision is actually made.

### 1.3 The clients answer, and the question is whether they answer

The assertion is not that a submission is accepted — a question taken and never
finished would satisfy that and prove nothing. It waits for the question to
settle and requires it to have succeeded, which a probe confirmed: a question
the engine cannot answer reads as `FAILED` and fails the test.

The suite also creates the location the engine writes its answers to. That is
the catalogue command's job from 4.2 onwards, and this suite arranges it itself
because it asks a question before that command exists — noted so it is removed
rather than duplicated when 4.2 lands.

### 2.3 The engine sends UTC and Node reads it as local time

`2026-08-27 02:00:00` handed to `new Date(...)` becomes `07:00:00Z` on this
machine, because a date-time with no zone written on it is read as **local**
time. Every moment in every answer would be silently shifted by the running
machine's offset — five hours here, none at all on a CI box set to UTC. A defect
that appears only where somebody actually works, and never where it is checked.

The zone is supplied when the value carries none. The test asserts the exact
instant rather than "parses to a Date", and the suite is green under
`America/Bogota`, `UTC` and `Asia/Tokyo` — because a timezone test that only
ever runs in one zone is a timezone test in name.

### 2.3 A probe that did not bite, and was not believed

The first attempt at the probe above reported all nineteen tests passing, which
would have meant the assertion was worthless. It was the patch that was
worthless: the replacement never matched, so nothing changed and the probe
measured the unmodified code.

Re-run with an edit that asserts it applied, it fails two tests. **The same trap
this repository has now hit three times** — a patch that silently matches
nothing — and the only reason it was caught is that a probe passing where it
should fail was treated as suspicious rather than as good news.

### 2.1 The period is inclusive; the export's window is half-open

They look like the same idea and are not. The export's window meets its
neighbour exactly and must not carry a movement twice, so it is half-open. A
period is a person naming the days they want to see, and somebody asking for one
day names it twice and means it.

Also: the shape of a day is not the calendar. `2026-02-30` matches the pattern
and is no date, and a period ending there would compare as a string and quietly
cover nothing.

### 2.2 Three states, because two of them are the same picture

"Nothing moved in that period" and "this tenant has never been carried" both
draw an empty chart, and only one of them means the data is missing. The union
is what forces a reader to narrow before reaching for entries — the type is the
guard, not a convention.

### 3.1 "A tenant identifier is a UUID" is not the export's fact

The rule lived as a private regex in the export's `partition.ts`, and the
analytics seam needs the same one for the same reason: a tenant identifier stops
being a value and becomes **part of something that is parsed** — a path there, a
statement here — and that is the one way a tenant could reach somewhere that is
not its own with every query still correct.

Moved to `domain/identifiers.ts`, where tenant identifiers live, with the caller
naming what the value was about to become so each refusal still says who refused
and why. Removing it fails **three** tests across two features, which is what a
shared rule owes — the lesson task 1.2 recorded, now with a second instance.

Deliberately **not** folded into `tenantId` itself. That one parses an
identifier arriving from outside, where a malformed value must become a refusal
indistinguishable from a tenant that does not exist. Throwing there would answer
the question the platform's disclosure rules say must not be answered.

### 3.2 The double and the real seam must agree on *how* they refuse

The refusal was written synchronously, so it threw where the port promises a
rejection. Every caller awaiting it saw no difference; one reaching for `.catch`
without awaiting would have missed it entirely.

Made `async`. Worth stating as a rule rather than a fix: a double owes the shape
of the real thing's failures, not only their existence, and 4.3 has to refuse
the same identifier at the same point in the same way.

### 3.2 What the double models, and why each one

Three properties, one per bug this repository has already paid for: the tenant is
bound and checked, a tenant never carried answers differently from one with
nothing to say, and **the period filters**. That last one would be easy to skip —
a double returning everything passes every use-case test while the use case asks
the engine for a tenant's whole history. The probe that ignores the period fails
exactly one test, and it is the one that had to exist.

### 3.1 Four reasons, and a debt to 4.1

`AnalyticsFailureReason` declares four classes of problem and, at this task,
nothing produces any of them — the adapter that raises them is 4.1. Recorded
here because the previous feature shipped a reason nothing could emit and its
validation gate is what noticed. **4.1 owes a producer for all four.**

### 4.1 The debt from 3.1 is paid

All four reasons now have a producer: `store-rejected` and `store-unreachable`
from the status a refused call came back with, `question-timed-out` from the
deadline, `question-failed` from an engine that answered `FAILED` or `CANCELLED`
and from any step that raised something unclassified. The previous feature
shipped a reason nothing could emit; this one will not.

Classification lives in the engine adapter because **that is the last place the
status code exists**. One layer up there is an exception carrying a driver's
wording, and matching on those is how a rephrased library message turns every
failure into the wrong kind.

### 4.1 Split into two files so the interesting half has no engine in it

The design named one file. Everything worth getting right here — waiting,
giving up, following pages — is behaviour the local engine can never exercise:
it answers in milliseconds and returns small results in a single page. So the
runner works against four named operations and the engine adapter is the only
file holding a client. Design's file plan corrected.

### 4.1 A test whose two rows were both the header

"Drops the header row and only that one" had a page whose every row equalled the
column names, so dropping row zero unconditionally produced the same answer and
the probe walked straight through. The distinguishing case — a first page whose
first row is real data — is now its own test, and the probe fails it.

**Third instance this feature.** The pattern is consistent enough to name: a
test that asserts what is kept needs a case where the wrong rule would keep
something different, and two rows that look alike is not that case.

### 4.1 My fake was looser than the thing it stood for, again

The refusal test built an `Error` wearing the right `name` and `reason` rather
than a real `AnalyticsUnavailable`, and `askingAs` recognises the class, not the
shape. The failing test was the fake being wrong, not the code.

### 4.2 A fourth Floci gap: `glue:GetTable` cannot be deserialized

The obvious integration test reads the tables back and asserts what they say.
It cannot: the JS SDK refuses the response with *"Epoch timestamps must be
expressed as floating point numbers or their string representation"*.

Traced rather than guessed. The raw response is fine except for one field —
`LastAccessTime: null`, where real AWS sends a number or omits it. The AWS CLI
(Python) tolerates the null; the JS SDK does not. Everything else came back
exactly as sent, projection properties included, which is how it was confirmed
that the catalogue itself is correct and only the read-back is unusable.

So the suite asserts **the command's own report** — which tables it created,
which it updated — plus what the engine actually answers. That is the better
test regardless: the report is what an operator reads, and an answer from real
objects is what the catalogue is *for*.

Fourth gap in this feature, after: no partitions needed, every column typed as
text, and parameters dropped.

### 4.2 The columns are derived from the export, not restated

There is one list of movement columns on this platform, and the catalogue reads
it. A column added upstream therefore cannot drift from the one an engine was
told about — the alternative is two lists that agree until the day they do not,
and the disagreement surfaces as a chart with a missing series.

The published columnar type is translated to the engine's spelling in one table,
and a probe that describes a quantity as text fails the test that checks it.

### 4.2 What is asserted where, and why the split matters here most

The unit spec asserts **the values the command sends**; the integration suite
asserts **that the command runs, repeats safely, and leaves an engine that
answers**. Nothing asserts the partition arrangement is correct, because nothing
locally can: the emulator infers partitions from the key path and answers either
way.

This is the task the "declared, not verified" section of `design.md` was written
for, and the split is what keeps that honest rather than merely stated.

### 4.3 The probe the task named, and what it actually produced

Removing the tenant from the statement does not merely widen the answer — it
hands one tenant the sum of every tenant in the bucket. Acme, which received
ten, is told **745**, along with days and kinds belonging to nobody it knows.

Three tests fail on it. That is the failure the seam exists to prevent, and it
is now a red test rather than a paragraph.

Three more probes bite: dropping the period bound, dropping the explicit order,
and returning a default moment where the tenant has no mark.

### 4.3 The gap between the two questions is kept in the types

This task answers one of the port's two questions and 4.4 answers the other.
Rather than ship a `stockOnHand` that compiles and throws, the class hands out
`Pick<TenantAnalytics, 'movementsByDay'>` and does not claim to implement the
port yet. The compiler holds the gap until 4.4 closes it.

Written the other way first, and corrected before the probes — a throwing method
is a lie that type-checks.

### 4.3 A suite that emptied the whole bucket

Two tests failed in one full integration run and passed in the three runs after
it, and I did not capture which — recorded plainly because it is the **second
sighting** of an unattributed integration failure in this repository.

Looking for a cause turned up a real hazard, whether or not it was the cause:
`export-sink` deleted **every object in the bucket** between its tests, and
asserted about `movements/` across every tenant. Harmless while the export was
the only thing writing there; not any more, now that the analytics suites write
and read the same bucket. Both are now scoped to the tenant that suite owns.

Not claimed as the fix for the flake — that connection is unproven. Claimed as
what it is: a suite reaching outside its own prefixes, found while looking, and
exactly the shape that produces intermittent failures in whichever suite runs
next.

### 4.4 The flake, caught and named

The unattributed integration failure recorded in 4.3 reproduced here — three
runs of one suite, one or two failures each time, always the tests that seed
**two** tenants. Captured this time, and it is not a correctness problem at all:

```
thrown: "Exceeded timeout of 5000 ms for a test."
```

Those tests seed two tenants, run two exports, apply the catalogue and then ask
four questions of an engine that polls. That is honest work and it does not fit
in Jest's five-second default. It fitted while the tests used one tenant, which
is exactly why it arrived as an intermittent failure rather than an obvious one
— and why the earlier full-run failure appeared under load and vanished on a
quiet machine.

Both analytics suites now carry a suite-level timeout, the same fix
`inventory-throttling` needed in the previous feature and for the same reason: a
verification run cannot be trusted while it is flaky, so it is fixed rather than
re-run until green.

**Two probe readings had to be discarded and retaken.** The first run of probes
B and C reported a `movementsByDay` test failing, which neither probe touched —
that was this timeout, not the probe. Retaken after the fix, each breaks exactly
the three `stockOnHand` tests and nothing else. A probe read against a flaky
suite measures the flake.

### 4.4 Two tables, two places to lose the tenant

Joining on `tenant_id` alone would be one condition where the layout wants two,
and both probes prove it: constraining only the movements side and constraining
only the catalogue side each fail three tests. With the tenant projected as an
injected column, an engine would additionally refuse a question that left either
table unconstrained — belt over braces, and not something any local test can
show.

The join is an inner one on purpose. A movement whose product is not in the
catalogue would vanish; that cannot happen because the transactional API refuses
a movement naming a product nobody declared, and if it ever could, a missing
label would be the smaller half of that problem.

### 4.4 The port is satisfied, and now says so

`AthenaAnalytics` declares `implements TenantScopedAnalytics` for the first
time. The `Pick` that held the gap through 4.3 is gone rather than left behind
— which is the point of putting the gap in the type system: the compiler is what
notices when it closes.

### 5.1 The kind of caller is the only layer left, and that is the design

Every other tenant-scoped use case checks the role again from inside its own
transaction — the second layer that makes a use case refuse when called from a
queue consumer or a scheduled job rather than from its route. That layer is
**unavailable here by construction**: a membership lives in PostgreSQL, and 3.4
forbids reading it to answer a question. The role check is the guard's alone.

What survives is the part that needs no records: `tenantOf` admits a tenant
member and nothing else, so an operator, a person acting in no tenant and a
**machine** are all refused before the seam is reached. Decision 7 excludes
machines deliberately — an analytical question is expensive, and admitting keys
would let an automated client decide how often that cost is paid.

`tenantActedIn`, the sibling that admits machines and which the inventory reads
use, fails both refusal tests when substituted. Narrowing either role list to
administrators fails both role tests.

### 5.1 The use case owes the same shape of failure the port promises

`tenantOf` throws synchronously. A non-`async` `execute` would let that escape
as a synchronous throw while every other failure arrived as a rejection — one
promise, two shapes, and a caller reaching for `.catch` without awaiting would
see only one of them.

Caught by the tests written first, which is the **second instance** of exactly
this in this feature: task 3.2 had to make the double's refusal `async` for the
same reason. Worth stating as a rule now that it has happened twice: anything
that can refuse before it starts still owes the shape of failure its return type
declares.

### 5.2 The period is not validated here, and that is not an omission

1.4 and 1.5 are satisfied by the type, not by a check. `MovementHistoryQuery`
requires a `Period`, `periodFrom` is the only way to make one, and it refuses an
unbounded or over-long span — so a refused period never becomes a query and can
never reach the engine. A use case re-checking it would be checking something
that cannot arrive.

Two tests hold that shut. One asserts the refusal happens with the seam never
consulted, which needed a counting wrapper: "the call rejected" cannot tell a
period refused before the engine from a question that ran and then failed. The
other is a `@ts-expect-error` on a query built without a period — an assertion
that fails the build the day the field becomes optional.

### 5.2 A probe that matched and still measured nothing

The first run of the role probe reported four tests passing out of twenty. Not a
weak assertion — the patch had dropped a closing bracket, so both suites failed
to compile and the four that ran were a third file's.

The repository's recurring trap wearing a new face: three previous instances
were patches that matched **nothing**, this one matched and produced garbage.
The reading that gives it away is the same either way — a probe's test *count*
has to be the number the suite normally runs, and "4 passed" where twenty were
expected is not a green run.

### 5.2 One line of the design corrected

The allowed-dependencies table listed `src/domain/**`, `src/application/ports/**`
and Nest decorators, which forbids `ActorContext` — a use case cannot know who
is asking without it. The table now names the application's own pure helpers.

The constraint the table exists to protect is untouched and is the one the lint
rule actually enforces: no adapter, no driver, no repository. `tenant-authorization`
imports `TenantScopedRepositories` as a type only, so nothing on this path
reaches PostgreSQL at runtime.

### 6.1 A fifth reason, because the four described a store that answers

`not-configured` joins the closed set. An absent setting was going to be
reported as `store-unreachable`, and the reason set's own comment is the
argument against that: each one is "a different thing to do". An operator
supplies a value here; "unreachable" sends them to look at a host that is
answering fine. It has a producer, which is the debt 3.1 recorded and 4.1 paid
for the other four.

The missing keys travel as the cause, so they reach a log and no response. Env
key names are not a secret, but a message a caller can read is a message that
describes this platform's insides to whoever asks.

### 6.1 The API must start without analytical configuration, and now cannot fail to

`AnalyticsModule` is imported by `AppModule`, so anything it reads while the
graph is assembled is read on every boot. A provider factory calling
`loadAnalyticsConfig` would make an API missing `ANALYTICS_DATABASE` refuse to
start — taking sign-in, inventory and everything else down over a capability
none of them touch. `DeferredAnalytics` builds at the first question instead.

The export is the deliberate opposite and is right to be: it is a command,
nothing else is running, and refusing early costs nobody anything. **The same
requirement produces opposite answers in the two modules**, which is worth
saying out loud, because the export's validation gate found this trap from the
other side.

A failed build is not remembered, so a setting supplied to a running process
takes effect at the next question rather than at the next deployment.

### 6.1 The fifth bucket made four hand-written skip lists a real bug

`ThrottlerModule` is global: a bucket a route does not skip counts that route.
Every skip list on the platform was written by hand as "the buckets that
existed when I was written", and there were **four** of them — inventory's, and
two inside the authentication controller. Adding an analytics bucket required
editing all four, and missing one would have been invisible: the route keeps
working and simply spends somebody else's allowance.

They are derived from one registry now. `everyBucketExcept` refuses a name
nothing registers, and a bucket named but never registered fails a test rather
than being skipped everywhere and counting nothing.

**A probe restored inventory's hand-written list and every test passed.** The
derivation made the mistake unrepresentable but nothing was *watching* — no
test had ever asserted what a controller actually skips. It does now, read off
the decorator's own metadata, and the probe fails four tests.

### 6.1 A constant that exists in the types and not at runtime

Reading that metadata needs the key `@SkipThrottle` writes under.
`@nestjs/throttler` declares `THROTTLER_SKIP` in its type definitions and does
not export it: importing it type-checks and yields `undefined` at runtime, which
turned every lookup into a miss and every assertion into two empty objects
comparing equal.

It is discovered instead — apply the decorator to a throwaway class, read back
which key appeared. A library that changes its key now throws here rather than
letting the suite pass vacuously. **A test that reads a framework's internals
has to prove it found them.**

### 6.1 The bucket had never been emptied, and every question paid for it

`analytics-queries` began failing roughly two runs in three, in isolation, with
`the engine answered FAILED`. Nothing in this task touched it, and 4.4 had
recorded three clean runs — those runs were luck.

The engine's own reason, captured rather than guessed:

```
IO Error: Could not connect to server error for HTTP GET to
'http://floci:4566/cubeforge-exports/?prefix=movements%2F'
```

The local engine rebuilds a view over the **whole** prefix on every question,
whichever table is being asked about. Nothing had ever emptied the export
bucket, so the cost of one question grew with every tenant every run had ever
exported, until the emulator started failing to reach its own object store
mid-query. It read as an intermittent defect in the analytics and was neither:
it was a fixture that never reset.

Emptied once in `globalSetup`, before any suite starts. That is the distinction
4.3 drew from the other side — a suite clearing the bucket between its own tests
is reaching into whatever runs next, while a prerequisite of the run is arranged
once, before anything is using it, exactly as the database is migrated. **The
whole integration run went from ~200s to ~105s.**

### 6.1 The fifth Floci gap: an empty prefix is an error, not zero rows

With the bucket now actually empty at the start of a run, a new failure
appeared — and it is a fidelity gap rather than a defect:

```
IO Error: No files found that match the pattern "s3://…/movements/**"
```

Real Athena reads an empty partition as zero rows, which is exactly what
requirement 3.3 wants: a tenant nothing has ever been carried for answers
"never exported". The local engine cannot build the view at all, so **a store
before its first export cannot be asked anything locally**, and no local test
can distinguish the correct behaviour there from this one.

The adapter is **not** taught to recognise that message. Matching on a driver's
wording is the mistake this repository has refused four times, for the same
reason each time. The fixture arranges around the gap instead:
`useAnalyticalStore()` guarantees a catalogue and one exported tenant, and says
in its own comment why the second half is needed.

Fifth gap in this feature, after: no partitions needed, every column typed as
text, parameters dropped, and `glue:GetTable` undeserialisable.

### 6.1 Two platform guards demanded the new route, which is what they are for

`declaration-drift` and `route-inventory` both failed the moment the controller
existed, each naming the route rather than a count. `role-matrix` then failed
because it covers every route the application serves — so the analytical route
is exercised for all six principals, which is 5.2 and 5.3 arriving a task early
and for free. None of the three was edited to stop complaining; each was given
what it asked for.

`role-matrix` also needed the suite timeout the analytics suites carry, and for
the same reason: one of its routes now asks a polled engine, once per principal
it admits, and that does not fit Jest's five-second default. It fitted while
every route there was a single indexed query.

### 6.1 Files the design's plan did not name

Four, each recorded rather than quietly added:
`throttling-buckets.ts` and `platform-throttling.ts` (the registry and its
composition — split so the names stay a leaf and no import cycle forms),
`deferred-analytics.ts` (7.1's timing, which the plan implied and did not
place), and `analytics-failure.filter.ts` (the platform maps errors to
responses in a filter; a controller `try`/`catch` would have been the first
exception to that).

`analytics-route.integration-spec.ts` is 6.1's own local-stack proof, kept
separate from the `analytics-http` file the plan reserves for 7.3.

**Three more, found by the feature gate rather than recorded here at the time:**
`analytics-edge.spec.ts` (6.1 — the route without an engine behind it,
where the period refusals are observable and an engine would only be measuring
the engine), `analytics-clients.integration-spec.ts` (1.3) and
`analytics-answers.integration-spec.ts` (7.2 — the plan reserved
`analytics-queries` for the 4.x statements and named no file for the drawability
suite). All three are tests; none changes the shape of anything. Listed late is
still better than not listed, and the gate found them by diffing the plan
against `ls` rather than against this note — which is the check worth keeping.

### 7.1 The expectations are read out of the bucket, not written into the file

Every assertion in this suite is derived from the objects the export actually
wrote — listed under the tenant's own prefixes and read back with `hyparquet`,
the library that did not write them — and then aggregated the way the statement
says it should be. A list of expected rows typed into the file would agree with
the engine only until somebody changed both, and would stop being evidence the
moment it did.

The oracle needs its own probe, and got one: pointed at the *other* tenant's
prefixes it fails the comparison, which is what proves it is reading per-tenant
objects rather than everything in the bucket.

### 7.1 Two tenants alike in everything but the tenant

Same product code, same location code, same days, same kinds. Nothing but
`tenant_id` tells their rows apart, so a lost predicate cannot hide behind a
difference in the data.

The **names differ**, and that is the part worth keeping. Dropping the tenant
from the movements side gives a tenant the other's *number*, which a quantity
check catches. Dropping it from the **catalogue** side gives a tenant the
other's *label* with its own number beside it — a leak no quantity check would
ever notice, and the probe proves it: `a widget belonging to Globex` appears in
Acme's answer.

Three probes, three distinct failures: no tenant in the movements statement
(2 tests), none on the catalogue side of the join (2), none on the movements
side of the join (1).

### 7.1 Nobody appears, and there is nowhere for anybody to

A person is seeded in each tenant so that "no person is named" has somebody to
not name, and neither identifier nor address appears in any of the four
answers. That alone is an accident of the data, so the entries' key sets are
asserted as well: three fields each, exactly. A column added to an answer fails
here rather than being noticed by whoever reads a chart six months later — and
a probe adding `recordedBy` to the on-hand entry fails two tests.

### 7.1 A `beforeAll` seeds before the cleanup runs

The suite failed as a whole, roughly one run in three, and only in the full
integration run — never in isolation. Captured rather than left unattributed,
which is what 4.3 recorded and did not manage:

```
error: duplicate key value violates unique constraint "tenants_name_unique"
  at seedTenant … at lookAlikeTenant
```

Tenant names are unique platform-wide, and this suite seeds in `beforeAll` —
which runs **before** the per-test cleanup. So a tenant called "Acme" left
behind by whichever suite happened to run last collides with this one's, and
whether it does depends entirely on suite order and on what the previous run
left. In isolation there is nothing to collide with, which is exactly why six
runs of the file alone said nothing.

The name is generated now and the label kept separate: the label is what the
answers are checked against and has to be recognisable, while the name only has
to be free. Worth stating generally — **a fixture that seeds in `beforeAll`
inherits the previous suite's leftovers**, and any of it that must be unique
platform-wide has to be generated rather than chosen.

### 7.2 The decoder was never the thing in doubt

`decodeRows` is unit tested and will turn text into numbers all day. What only
a real engine can show is that the text arriving is the text the decoder was
written for — and the local engine reports **every column as `varchar`**, so a
result typed from what it says would have passed every unit test and failed
here. That is why these assertions are worth their runtime rather than being a
slower copy of the ones already passing.

A probe that leaves quantities as text fails three tests.

### 7.2 One narrative carries 3.1 and 3.2 together

Export, ask, record something new **without exporting**, ask again, export,
ask a third time. In the middle the answer must not have changed and its
moment must not have moved — the new movement is already in the transactional
database and still belongs after the line the answer draws. At the end both
must move together.

The middle assertion alone would pass against a watermark that never advanced,
and the last one alone would pass against an answer dated from the clock. Two
probes, one each: a moment read from `new Date()` rather than from the mark
fails the middle, and it is the pair that makes "not yet" mean something other
than "never".

### 7.2 Ordering needs data a wrong statement could reorder

Recorded out of order, and two kinds on one day, so `ORDER BY` has something to
get wrong. Asked twice and compared — and then compared against the order the
statement *declares*, because two runs agreeing tells you only that the engine
is deterministic today, not that the order is the one a chart was promised.

A probe removing the explicit order fails two tests.

### 7.2 Three states, all three seen against the real engine

A tenant recorded but not carried answers `never-exported`; a quiet period
answers with no entries; a period with activity answers with them. The first
two draw the same empty chart and only one of them means the data is missing.
The probe the task named — a default moment in place of "never carried" — fails
exactly the first.

### 7.3 An instrument with no positive control is a claim about the instrument

3.4 says the analytics must not consult the transactional database, and the task
asked for that **asserted rather than reasoned about**. The first instrument
read PostgreSQL's own `pg_stat_all_tables` scan counters before and after a
request. It passed.

Then the positive control — the transactional stock route, whose entire job is
to sum `stock_movements` — reported **no scans either**. The statistics are
accumulated per backend and flushed on a schedule a request-shaped window does
not see, so both readings were measuring flush timing. Widening the settle
interval past the flush interval did not fix it; the counters simply did not
move for the application's own backends within any window worth waiting for.

So the instrument was replaced rather than the control removed. A tenant
transaction is the only way anything here reaches tenant-owned rows, so counting
them counts consultations exactly: authorization opens one, and a route that
answers from PostgreSQL opens a second. An analytical request opens **only the
first**, whether it succeeds or the store is unreachable — and the stock route
opens two, which is what makes the other two numbers a measurement.

Recorded because the pattern generalises: **a measurement that only ever reports
"nothing happened" agrees with every hypothesis**, and the only way to tell it
from a working one is to make it report something.

### 7.3 The probe the task named walked past a whole assertion

"Done when the whole thing fails if a failure is allowed to repeat what the
engine said." Appending the driver's wording to the 503 body failed the exact-body
test and **passed the disclosure test** — because `connect ECONNREFUSED
127.0.0.1:4599` happens to contain none of the strings that test forbade.

A list of forbidden words is a guess about which words a library chose. The body's
key set is now asserted instead: `statusCode`, `message`, `reason`, and nothing
else. Any added field fails, whatever it says. The forbidden-string list is kept
as well — it is cheap, and it says out loud what must never appear.

### 7.3 Unreachable is a real adapter pointed at nothing

Not a stub that throws. What is being exercised is the classification, which
reads the status an actual refusal came back with — and a stub would only assert
that this test can construct the error it expects. A port nothing listens on
gives `store-unreachable` through the real path.

The deadline (6.2) is proven at the adapter with a zero budget rather than
through the route, because the route's budget is thirty seconds and a suite is
not going to wait for it. Same runner either way.

### 7.3 The shared fixture had the defect 7.1 had just named

`useAnalyticalStore()` seeded a tenant called "Analytical store fixture" — a
**fixed** name, in a `beforeAll`, which is exactly the collision 7.1 recorded one
task earlier. It bit as soon as a second suite used the fixture: two suites, one
name, and the first one's copy still there.

The note was written and the instance one directory away was left standing.
Worth keeping as a reminder that a lesson recorded is not a lesson applied —
grep for the shape, not only for the file that taught it.

### Feature validation: 5.5 was arranged everywhere and asked nowhere

The gate found one requirement whose implementation was complete and whose
evidence was not. The bucket is registered, the guard is mounted, the skip list
is derived and asserted off the decorator's own metadata, and the limit is read
from the environment. Every one of those is a statement about the *arrangement*.
The requirement is that an eleventh question in a minute is refused, and nothing
on the platform had ever asked twice.

The design said so itself, under *Through the running application*: "The limit
on how often one caller may ask (5.5)". It was planned and then not written —
the failure mode a per-task reviewer cannot see, because no single task owned
both the bucket and the proof.

`analytics-throttling.integration-spec.ts` asks eleven times. It also carries the
decision the bucket exists for and which had no probe at all: **counted per
caller, not per tenant**, so two people on one dashboard are two callers and an
eager one does not look, to their colleague, like an outage.

**Three probes, three failures.** Removing `@UseGuards` fails the first two;
counting by `params.tenantId` instead of by the caller fails the third; removing
`@SkipThrottle` fails it too.

### Feature validation: a fourth test that no probe could make fail

The suite was written with a fourth test — that spending the analytical
allowance leaves the other buckets alone — and every probe left it green.

The arithmetic is why. Ten analytical questions cannot exhaust an inventory
allowance of sixty, nor a sign-in origin allowance of sixty; and the sign-in
address bucket keys on a hash of the email in the body, which a GET with no body
never shares. So the assertion could not be made to fail by removing the very
skip list it was written to defend. It was not weak evidence — it was none.

Deleted rather than kept. The skip list's real witness is the metadata assertion
in `throttling-buckets.spec.ts`, which a probe fails four times over, and the
behaviour is caught in passing by the per-caller test above. **This is the same
finding as 7.3's positive control arriving from the other side**: there, an
instrument that reported nothing was replaced because it agreed with every
hypothesis; here, an assertion that agreed with every hypothesis was removed
because there was nothing to replace it with. Both are the same rule — a check
that cannot fail is not a check — and it is worth writing down that the rule
sometimes ends in a deletion rather than in a better test.
