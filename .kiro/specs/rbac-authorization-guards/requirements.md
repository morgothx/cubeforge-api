# Requirements — rbac-authorization-guards

## Project Description (Input)

### Who has the problem

- **Whoever adds the next route.** Nothing about a new controller method obliges
  it to be authorized. Protection comes from remembering to call a function
  inside the use case behind it, and forgetting is silent: the route ships, it
  works, and it is open.
- **Whoever reviews the code.** A reviewer reading a controller cannot tell what
  a route requires. They have to follow it into the use case and read the
  argument of a call several lines down.
- **Tenant users with a role that grants nothing.** `editor` and `viewer` exist
  in the role vocabulary and in the isolation matrix, but every tenant route
  currently permits `admin` and nothing else. The three roles are, in practice,
  two: administrator and refused.

### Current situation

Authorization works and is tested. It simply lives in one layer, called by hand.

- A single function resolves the tenant, the person and their membership
  **inside the tenant transaction the use case has already opened**, applies the
  access rule that feature 1 owns, and refuses. Twelve use cases call it or its
  operator-only counterpart, each passing its own permitted list — currently
  `admin` in all seven tenant-scoped cases.
- Refusals surface as absence, never as denial, so a caller cannot confirm that
  an identifier exists somewhere on the platform. Denial is reserved for an actor
  who genuinely belongs to the tenant and only lacks the role.
- The code says so in a comment: enforcement is a plain function and not
  reusable infrastructure *on purpose*, because "the design puts reusable
  enforcement in feature 3, and building any of those here would pre-commit a
  decision that belongs to that spec".
- Feature 2 finished the other half of the question. Principals are now verified
  from a credential — an access token or an API key — and attached to the request
  before any route runs. Nothing a caller sends can name who they are.

So the enforcement is correct and the placement is provisional. Product steering
is explicit about where it belongs: authorization is "role checks and tenant
scoping applied as infrastructure, never per-route by hand", and every route
"declares its required roles" rather than being protected by not being mentioned
anywhere.

### What should change

**A route declares what it requires, next to the route**, and enforcement
happens before application logic runs.

**A route that declares nothing is refused, not open.** Default-open is the
failure mode this feature exists to remove.

**The application-layer check stays.** This is defence in depth, not a
relocation: a use case invoked from anywhere other than its route must still be
refused. Two layers that do not share a point of failure is the same principle
the tenant isolation already rests on.

**The two must not disagree, and must not cost twice.** Resolving a membership
needs the tenant transaction that the use case opens. Enforcement that opens its
own transaction reads the same rows a second time and can observe a different
answer than the use case does a moment later. How the two are reconciled is the
central design question of this feature.

**The three roles start meaning three things.** Reading the tenant's members
becomes reachable by all three roles; every mutation stays with the
administrator.

**A role declaration is about people.** An API key carries a role of its own,
and admitting a machine caller is a separate statement a route makes
deliberately. No route admits one today, and that must be written rather than
inherited by accident.

**The tenant × role matrix becomes an explicit requirement**, not only a suite
that happens to exist.

---

## Subject

Acceptance criteria below use **the Authorization Service** as their subject:
the route-level access declaration and enforcement capability of the CubeForge
API.

---

## Adjacent Expectations

**Relies on, does not own:**

- **The verified principal.** Establishing who the caller is belongs to feature
  2. This feature decides only what that principal may reach, and treats an
  unresolved caller as a caller with no principal.
- **The access rule itself** — whether the tenant is active, the person is
  active, and the membership grants a role — belongs to feature 1. This feature
  applies that decision at a new place; it does not restate or duplicate it.
- **Tenant scoping in storage** and the isolation layers behind it belong to
  features 0 and 1. Nothing here weakens them, and nothing here is their
  replacement.
- **The disclosure rules** stated in product steering — a refusal is
  indistinguishable from an absence, and existing elsewhere is not observable —
  apply unchanged and are not restated as new obligations.

**Explicitly out of scope:** permissions finer than roles, per-resource or
per-record access rules, delegation and impersonation, roles that vary by
resource type, custom or tenant-defined roles, and any change to who may hold a
role or how a role is assigned. Role granularity beyond the read/mutate split
below arrives with the business resources of feature 5.

---

## Requirements

### 1. A route declares what it permits

Enforcement follows a declaration attached to the route, so what an endpoint
requires is visible where the endpoint is defined.

- **1.1** The Authorization Service shall determine the roles permitted for a
  request from a declaration attached to the route being called.
- **1.2** If a route carries no access declaration, the Authorization Service
  shall refuse every request to it, including requests from principals that
  would satisfy any declaration the route might plausibly have carried.
- **1.3** When a route declaration is added, changed or removed, the
  Authorization Service shall enforce the new declaration with no corresponding
  change to the application logic behind that route.
- **1.4** The Authorization Service shall enforce a route's declaration before
  the application logic behind that route begins.
- **1.5** Where a route is reachable without any principal, the Authorization
  Service shall require that to be declared explicitly on that route.
- **1.6** The Authorization Service shall let a route declare that it requires a
  platform operator, and shall treat that declaration as distinct from every
  declaration of a tenant role.

### 2. Roles mean three different things

- **2.1** When a tenant member requests the list of their tenant's members, the
  Authorization Service shall permit the request while their role is
  administrator, editor or viewer.
- **2.2** If a tenant member whose role is editor or viewer requests any change
  to their tenant's membership, the Authorization Service shall deny the
  request.
- **2.3** If a tenant member whose role is not administrator requests any
  operation on their tenant's API keys, including reading them, the
  Authorization Service shall deny the request.
- **2.4** While a person holds different roles in different tenants, the
  Authorization Service shall decide each request by the role they hold in the
  tenant that request names.

### 3. A declaration is about people, and admitting machines is separate

- **3.1** The Authorization Service shall treat the roles a route declares as
  roles held by a person through a membership.
- **3.2** If a machine caller requests a route that does not declare machine
  callers admissible, the Authorization Service shall deny the request whatever
  role that caller's credential carries.
- **3.3** Where a route declares machine callers admissible, the Authorization
  Service shall permit a machine caller whose credential carries a permitted
  role and whose credential names the tenant the request names.
- **3.4** The Authorization Service shall declare no existing route admissible to
  machine callers.

### 4. Two layers that do not share a point of failure

- **4.1** The Authorization Service shall refuse an operation whose permitted
  roles are not satisfied, whether the request arrived through a route or the
  operation was invoked by other means.
- **4.2** When a route's declaration and the operation behind it disagree about
  which roles are permitted, the Authorization Service shall permit only what
  both permit.
- **4.3** The Authorization Service shall reach one decision per request, so that
  a decision cannot be granted at one layer and denied at the other for reasons
  the caller can observe as different outcomes.

### 5. Refusals disclose nothing

- **5.1** If a caller is refused because they hold no membership in the tenant
  they named, the Authorization Service shall answer as it answers a request for
  a record that does not exist.
- **5.2** If a caller is refused because their membership does not carry a
  permitted role, the Authorization Service shall answer with a denial that
  discloses nothing about the tenant, the resource, or which role would have
  sufficed.
- **5.3** The Authorization Service shall record the reason for every refusal
  where operators can read it, and shall include that reason in no response.
- **5.4** While a tenant is inactive or a person is deactivated, the
  Authorization Service shall refuse their requests as it refuses a caller with
  no membership.
- **5.5** If a request presents no principal at all, the Authorization Service
  shall refuse it as it refuses a caller whose membership does not exist, so that
  presenting nothing and presenting the wrong thing are indistinguishable.

### 6. Every role, refused in every direction

- **6.1** The Authorization Service shall permit no request that names a tenant
  the caller holds no membership in, for every role and every route.
- **6.2** When a route is added, the Authorization Service shall subject it to
  the same tenant and role coverage as every route that preceded it, and shall
  make the absence of that coverage detectable without reading the route.
- **6.3** When operator status is withdrawn from a person, the Authorization
  Service shall refuse their next operator-only request without requiring their
  credential to change.
- **6.4** The Authorization Service shall permit a platform operator no request
  to a route declared for tenant members, and shall permit a tenant member no
  request to a route declared for platform operators.
