# Research — rbac-authorization-guards

Discovery type: **light**. This is an extension of a working system, not a new
capability. Authorization already runs, is covered by an isolation matrix, and
has a comment in the code reserving reusable enforcement for this feature. What
had to be discovered is where enforcement can attach without duplicating the
access rule, and what it costs.

No new dependency is adopted. Everything below is already in the stack:
`@nestjs/common` 11 (guards, `SetMetadata`, `Reflector`), `@nestjs/core` 11
(`APP_GUARD`, `DiscoveryService`), `reflect-metadata` 0.2.

---

## Investigations

### 1. What runs before what

Nest orders a request: **middleware → guards → interceptors → pipes → handler**.
Three consequences shape the design:

- `PrincipalMiddleware` has already attached the verified actor by the time a
  guard runs, so a guard needs no credential handling of its own.
- Guards run **before** the `ValidationPipe`, so a guard may read
  `request.params` (populated by the router during matching) but must not depend
  on a validated body. Every declaration this feature enforces is decided from
  the route and the path, never from the payload — so this costs nothing.
- `OperatorActionInterceptor` runs after guards, which is the correct order: it
  records actions that were allowed to start, and refusals reach it as errors.

### 2. The transaction question, which is the whole design

`authorizeInTenant` resolves the tenant, the person and their membership
**inside the tenant transaction the use case opened**, because those reads must
run under the same published `app.current_tenant` that scopes everything else.

A guard cannot join that transaction: it runs before the use case exists, and
the unit of work owns the transaction's lifetime. Three ways out were
considered.

| Option | What it costs | Why not / why yes |
|---|---|---|
| Guard opens the transaction and hands it to the use case | The use case stops owning its own transaction and can no longer be invoked outside HTTP without one being fabricated | Rejected. It inverts the unit of work and puts an HTTP concern in the application layer's constructor path |
| Guard resolves nothing; only the use case decides | No extra read | Rejected. Requirement 1.4 wants refusal before application logic, and a declaration nothing enforces is documentation |
| Guard opens its own short transaction, resolves, and refuses | One extra transaction of three indexed single-row reads per tenant-scoped request | **Adopted.** See below |

The adopted cost is three primary-key or unique-index lookups on `tenants`,
`people` and `memberships`, on a pooled connection, in a read-only transaction
that commits immediately. It is the same shape of work the use case then repeats.
Measured decision, not an assumed one: the tasks include recording the actual
figure, the way task 1.2 of feature 2 measured an Argon2 hash rather than
inheriting a number.

**The two reads can observe different data.** A membership revoked between the
guard's read and the use case's read means the guard permits and the use case
refuses. The request is refused — the layers fail closed, which is the correct
direction and is why "permit only what both permit" (4.2) is expressible at all.
The reverse (guard refuses, use case would have permitted) simply refuses.

### 3. Declaration shape — one decorator or four

Four small decorators (`@Roles`, `@Public`, `@OperatorOnly`, `@AllowMachines`)
is the more conventional Nest idiom. One `@Access({...})` was adopted instead,
for a reason specific to requirement 1.2: *a route that declares nothing must be
refused*. With one metadata key, "undeclared" is a single absent key that a
guard and an inventory test can both check. With four independent keys,
"undeclared" is a combination — and `@AllowMachines()` alone, with no roles,
would read as a declaration while granting a shape nobody meant.

The trade is that `@Access({ roles: ['admin'] })` is slightly noisier than
`@Roles('admin')`. Accepted: it is read far more often than it is written.

### 4. Detecting an undeclared route without reading the route (6.2)

`DiscoveryService` plus `MetadataScanner` from `@nestjs/core` enumerate every
controller and every handler at runtime. This is the same mechanism Nest's own
tooling uses, is available without a new dependency, and gives the inventory
test a list it did not have to be told.

The runtime guard already refuses an undeclared route; the inventory test is
what makes the *absence* detectable at build time rather than when someone
finally calls the endpoint. Both are needed: the guard is the safety net, the
test is the feedback.

### 5. Where the declared roles and the enforced roles can drift (4.2)

The guard reads the declaration; the use case holds its own permitted list. They
are two statements of the same intent, and nothing yet stops them diverging.

Rejected: deriving the use case's list from HTTP metadata (the application layer
would import from the adapter layer, which ESLint forbids and which is the one
architectural rule this repository actually enforces).

Adopted: a test that walks the route inventory, extracts each route's declared
roles, and compares them against the permitted list its use case enforces. The
comparison needs the use case to expose its permitted roles as a value rather
than a literal buried in a call — a small, honest change to twelve files.

---

## Synthesis

### Generalization

Four questions — is this route public, does it need an operator, which tenant
roles may reach it, may a machine reach it — are one question: *which principals
may reach this route*. One declaration answers it, and one guard enforces it.
The interface is general; the implementation covers exactly the four shapes the
requirements name and nothing more.

### Build vs adopt

Adopt: Nest guards, `Reflector`, `APP_GUARD`, `DiscoveryService`. All native,
all already present. Building a custom enforcement pipeline would be inventing a
worse guard.

Build: the declaration and the guard's decision logic, because they encode this
platform's rules (roles are held by people through memberships; machines are
admitted separately; refusal is indistinguishable from absence). No library
knows any of that.

### Simplification

- **No permission abstraction.** Roles are the vocabulary; permissions,
  per-resource rules and custom roles are out of scope and none of them earns an
  interface today.
- **No new decision function.** `decideAccess` already answers whether an actor
  may act in a tenant. The guard calls the same one the use case does.
- **No caching of the guard's resolution for the use case to reuse.** It was
  considered — attach the resolved actor to the request and let the use case
  read it — and rejected: it would make the second layer depend on the first,
  which is exactly the shared point of failure the two layers exist to avoid.
- **The machine-admission path ships with no route using it** (3.4). It is
  covered by a fixture route in the test suite rather than by a real endpoint,
  so the mechanism is proven without inventing an endpoint feature 5 has not
  specified.

---

## Risks

| Risk | Mitigation |
|---|---|
| The extra transaction per request becomes a latency problem under load | Measure it during implementation and record the figure. The reads are indexed and single-row; if the figure is bad, the design decision above is the one to revisit, and it is isolated to the guard |
| The inventory test becomes a maintenance tax that people disable | It fails only on a genuinely undeclared or drifted route, which is the failure it exists to catch. Keep its message specific enough to act on |
| A refusal at the guard reads differently from a refusal at the use case | Both go through the same domain violation and the same error filter; the disclosure tests of feature 2 already assert byte-identical responses and are extended to cover the guard |
| Exposing permitted roles as values on use cases looks like ceremony | It is the only mechanism that makes 4.2 checkable without crossing the layer boundary. Recorded here so a reviewer sees the reason |

---

## Revalidation triggers

- A route needs a permission finer than a role, or a rule that depends on the
  resource rather than the tenant — the declaration shape stops being enough.
- Feature 5 opens routes to machine callers: the first real `machines: true`
  declaration exercises a path only a fixture covers today.
- A role becomes assignable per resource, or tenants define their own roles.
- The guard's extra read shows up in a latency budget.
