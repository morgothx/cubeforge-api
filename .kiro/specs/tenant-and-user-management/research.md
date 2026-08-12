# Research Log — tenant-and-user-management

*Discovery type: full (greenfield feature, no prior implementation)*
*Updated: 2026-08-12*

## Discovery Scope

The feature itself is conventional identity CRUD. The parts worth investigating
are the ones where a wrong choice fails silently rather than loudly:

1. How row-level security interacts with connection pooling under Drizzle.
2. Whether Drizzle can express RLS policies in migrations, or whether they must
   be maintained as loose SQL.
3. How to serve the platform-operator boundary (requirement 3) without giving
   the operator a database identity that can read tenant contents.
4. Whether the non-disclosure requirement (4.3) is achievable in practice.

## Investigations

### RLS requires transaction-scoped context, not connection-scoped

**Source:** [Drizzle RLS docs](https://orm.drizzle.team/docs/rls),
[drizzle-orm discussion #2450](https://github.com/drizzle-team/drizzle-orm/discussions/2450)

PostgreSQL's `set_config(key, value, true)` and `SET LOCAL` persist only for the
current transaction. Connection poolers reuse physical connections across
requests, so a tenant value set outside a transaction either leaks into an
unrelated later request or is silently absent, leaving policies evaluating an
empty context.

**Implication:** every tenant-scoped operation must run inside a transaction that
first publishes the tenant. This is not an optimization — a read issued outside a
transaction is a correctness bug, not a slow path. The design makes the
transaction boundary the only way to reach tenant-scoped data, so the mistake is
structurally unavailable rather than merely discouraged.

**Secondary finding:** in transaction pooling mode, prepared statements are not
supported (`prepare: false` on the client). Recorded as a deployment constraint,
not currently exercised by the local Docker environment.

### Drizzle expresses RLS in the schema

**Source:** [Drizzle RLS docs](https://orm.drizzle.team/docs/rls)

Drizzle supports `pgPolicy()` (with `as`, `to`, `for`, `using`, `withCheck`),
`pgRole()`, and table-level RLS enablement, so policies live in the same schema
files as the tables and are emitted by `drizzle-kit` migrations.

**Implication:** policies are reviewable in the same diff as the tables they
protect, and drift between "table added" and "policy added" becomes visible in
code review. Adopted.

**Gap for implementation:** the exact table-level enablement API surface
(`.enableRLS()` versus a `withRLS` table variant) was reported inconsistently
across sources. Verify against the installed version before writing the schema;
this affects one line, not the design.

### Two database roles, because owners bypass RLS

**Source:** [drizzle-orm discussion #2450](https://github.com/drizzle-team/drizzle-orm/discussions/2450),
PostgreSQL RLS semantics

A table owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set. If the
application connects as the role that owns the tables — the default when one
connection string does everything — RLS is decorative.

**Decision:** separate the migration identity (owns the schema) from the runtime
identity (restricted, subject to policies). Additionally set `FORCE ROW LEVEL
SECURITY` so ownership alone can never re-open the hole.

### Serving the operator boundary at the database

Requirement 3 states that platform operators manage tenants as containers and
cannot read their contents. Two options were considered:

- **Single runtime role, context value distinguishes operator from tenant.**
  Fewer moving parts, but the operator boundary then exists only in policy
  predicates driven by an application-supplied string.
- **A second restricted runtime role for operator work.** Operator sessions
  authenticate as a role with no policy granting access to memberships or
  tenant-owned data at all.

**Chosen:** the second. It costs one more role in the migration and makes
requirement 3.2 enforceable by the database rather than by remembering to write
the right predicate. Rejected alternative recorded here rather than in design.md.

### Non-disclosure (4.3) is achievable in content, approximate in timing

Response content and status can be made identical between "person was new" and
"person already existed" by always performing the same sequence of work and
never branching into an early return.

Timing is a weaker guarantee: creating a person writes one more row than
attaching a membership to an existing one. The difference is a single insert
inside a transaction that already performs several statements, well below the
noise floor of network round-trip variance for a remote caller.

**Accepted residual risk:** a local attacker with a large sample could in
principle distinguish the two paths. Mitigating that fully (constant-time
padding) is disproportionate for this feature and is recorded as a known limit
rather than silently ignored.

## Synthesis

### Generalization

Requirements 2.2, 6.2, 8.1 and 9.1 are surface variations of one underlying
question: *is this actor permitted to act in this tenant right now?* Tenant
inactive, membership revoked, person deactivated platform-wide, and wrong tenant
entirely all resolve to the same answer through different causes.

Designed as one evaluation — an access decision computed from tenant status,
membership status and person status together — rather than four scattered
checks. The interface generalizes; the implementation stays exactly as large as
the current requirements demand.

Requirements 7.1 and 7.2 are likewise one rule reached from two directions
(revocation and role change), so they are one domain invariant, not two.

### Build vs. Adopt

- **Tenant scoping:** adopt PostgreSQL RLS rather than build a query interceptor.
  It is the platform-native solution and cannot be bypassed by future raw SQL.
- **Schema migrations:** adopt `drizzle-kit`. No custom migration runner.
- **Identifier generation:** adopt UUIDv7 rather than a custom scheme —
  time-ordered, so it indexes well, and it does not expose a sequential count of
  tenants or users the way an integer key would.
- **Nest integration:** build. A provider module is smaller than the maintenance
  risk of the unmaintained third-party integrator (see `CLAUDE.md`).

### Simplification

- No separate `PersonService` and `MembershipService`. Creating a member is one
  transaction spanning both records; splitting it would invent a distributed
  concern inside a single database.
- No repository interface for the transaction runner *and* a separate unit-of-work
  abstraction. One port covers it.
- No caching layer. There is no measured read pressure, and a cache in front of
  authorization decisions is a correctness hazard, not a performance win.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A tenant-scoped query issued outside a transaction silently returns nothing or, worse, another tenant's rows | Critical — defeats the feature's purpose | Tenant-scoped repositories are reachable only through the transaction runner; an isolation test asserts the failure mode directly |
| Policies exist but the runtime role owns the tables | Critical — RLS becomes decorative | Separate migration and runtime roles, plus `FORCE ROW LEVEL SECURITY` |
| A new tenant-owned table ships without a policy | High — a hole opens quietly | Test that fails when a tenant-scoped table has RLS disabled |
| Requirement 3 enforced only in application code | Medium | Dedicated operator role with no grants into tenant-owned tables |

## Open Gaps for Implementation

- Confirm the table-level RLS enablement API for the installed Drizzle version.
- Confirm UUIDv7 availability in the chosen id source; fall back to UUIDv4 if the
  ordering benefit is unavailable, which changes nothing behavioral.
