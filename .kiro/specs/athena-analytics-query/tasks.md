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

- [ ] 4.3 Bind the tenant, read the mark, and answer what moved
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

- [ ] 4.4 Answer what is on hand, named rather than only coded
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

- [ ] 5.1 (P) Answer what is on hand
  - Admitted to administrators, editors and viewers alike
  - Done when a tenant with movements across two products gets both, each named,
    and a tenant that has never been carried is reported as such rather than as
    having nothing
  - _Depends: 3.2_
  - _Requirements: 1.1, 1.3, 3.3, 5.2_
  - _Boundary: Analytics use cases_

- [ ] 5.2 (P) Answer what moved, day by day
  - The period comes from the caller, and a question without one or with one too
    long never reaches the engine
  - Done when a period holding three days of activity yields three days, and a
    period holding none yields an answer with no entries rather than a refusal
  - _Depends: 2.1, 3.2_
  - _Requirements: 1.2, 4.2, 5.2_
  - _Boundary: Analytics use cases_

## 6. Wiring

- [ ] 6.1 Give the caller a route, and the application a module
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

- [ ] 7.1 (P) Show that no tenant reaches another's numbers
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

- [ ] 7.2 (P) Show that an answer can be drawn without repair
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

- [ ] 7.3 (P) Show what the route does when it cannot answer
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
