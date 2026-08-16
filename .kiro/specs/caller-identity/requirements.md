# Requirements — caller-identity

## Project Description (Input)

### Who has the problem

- **Any client that has just signed in.** It holds an access token and knows
  nothing else. It cannot render a navigation bar, choose a tenant, or decide
  which controls to show, because it has no way to learn who it is acting as or
  where that person belongs.
- **The dashboard of feature 4 in particular**, which the frontend's own
  instructions require to "reflect the current user's role (admin/editor/viewer)
  as returned by the backend". The backend returns it nowhere.
- **Anyone integrating against the API**, who today has to be told their tenant
  identifier out of band before they can call a single tenant-scoped route.

### Current situation

Signing in answers `{ accessToken, refreshToken, sessionExpiresAt }`. The token
carries `{ sub, iss, exp }` and nothing more — deliberately, and the reason is
written into the issuer:

> The token is a signed statement that a person authenticated, and nothing else.
> It names no tenant and no role: a person may hold memberships in several
> tenants, and a claim about one of them would outlive a membership that can be
> revoked at any moment.

That decision stands and this feature does not reopen it. Putting roles in the
token would make a demoted administrator an administrator for up to fifteen
minutes, which is precisely what the role matrix now proves cannot happen.

What is missing is the query. There is no route a person can call to learn their
own memberships:

- `GET /tenants` is declared `{ operator: true }`, so a tenant member is refused.
- `GET /tenants/:tenantId/members` returns roles — including the caller's own —
  but needs a tenant identifier the caller has no way to obtain.
- Every refusal is a 404, so a client cannot even discover a tenant by probing.

**Three structural gaps sit behind this, found before writing any requirement:**

1. **The access declaration has no shape for "any authenticated person".** The
   vocabulary from `rbac-authorization-guards` offers `public`, `operator`,
   `roles[]` and `roles[] + machines`. Every route so far was public, or an
   operator's, or lived inside one tenant. This route is the first that is none
   of those: a member and an operator both reach it, and its path names no
   tenant.
2. **No database identity can read one person's memberships across tenants.**
   `cubeforge_app` holds the grant but its policy pins it to
   `tenant_id = current_tenant_id()`, one tenant per transaction.
   `cubeforge_authenticator` has no grant at all — a test asserts the refusal.
   `cubeforge_operator` has none either, and the migration says that is
   deliberate. Iterating tenants with the app identity is circular: knowing
   which tenants to iterate is the question being asked.
3. **A principal cannot currently be "a person, acting in no tenant".** On a
   path that names a tenant the resolver produces a tenant member; on one that
   does not, it produces a platform operator or nothing at all. So an ordinary
   member calling a tenantless route resolves to no principal and is refused —
   not by a rule, but because the shape does not exist. `ActorContext` says the
   same: its three kinds are an operator, a member *with* a tenant, and a
   machine. This route needs the missing fourth.

Together these make the feature larger than the endpoint it delivers. It touches
the actor union that three features already switch on, the resolver, the access
declaration and its guard, and the persistence layer — which is the honest size
of "let a caller ask who they are", and the reason it is a spec rather than an
afternoon.

### What should change

**One query answers who the caller is and where they belong.** A person, their
address, whether the platform records them as an operator, and the tenants they
are a member of with the role they hold in each.

**It is read per request, never cached in a credential.** A client that re-asks
after a role changes sees the change, which is the whole reason this is a query
and not a claim.

**It discloses only the caller's own standing.** Not other people, not tenants
they do not belong to, and nothing that would let them enumerate the platform.

**The access declaration gains the shape this route needs**, rather than this
route being forced into a shape that means something else — declaring it
`public` would be a lie, and declaring it for roles would name a tenant it does
not have.

**Reading a person's own memberships becomes possible without weakening tenant
isolation.** Whatever grants that requires must stay confined to the caller's
own rows; a route that answers "where do I belong" must not become a way to ask
where anyone else belongs.

---

## Subject

Acceptance criteria below use **the Identity Service** as their subject: the
capability that answers a caller's own identity and standing across the
platform.

---

## Adjacent Expectations

**Relies on, does not own:**

- **Who the caller is.** Feature 2 verifies the credential and resolves the
  principal; this feature reports what that principal amounts to.
- **The access rule.** Whether a membership grants anything is feature 1's
  `decideAccess`, and whether a route admits a caller is feature 3's guard.
- **The disclosure rules** — refusal indistinguishable from absence, existing
  elsewhere unobservable — apply unchanged.

**Owns:**

- What a caller may learn about their own standing, and in what shape.
- The declaration shape for a route open to any authenticated person, and its
  enforcement.
- Whatever persistence change is needed to read one person's memberships across
  tenants without widening what anyone can read about anyone else.

**Explicitly out of scope:** changing the access token's payload, any endpoint
about *another* person's standing, tenant switching or session state on the
server, and preferences or profile data beyond what authorization already
records.

---

## Requirements

### 1. A caller learns their own standing

- **1.1** When a caller whose credential resolves to a person asks for their own
  standing, the Identity Service shall answer with that person's platform-wide
  identifier, their email address, whether the platform records them as an
  operator, and every tenant membership that currently grants them access.
- **1.2** The Identity Service shall report, for each membership, the tenant's
  identifier, the tenant's name, and the role the caller holds in it.
- **1.3** While a membership does not currently grant access — revoked, or held
  in a tenant that is not active — the Identity Service shall omit it, so that
  nothing it reports names a place the caller would then be refused.
- **1.4** While a person is recorded as a platform operator, the Identity Service
  shall report that fact and shall still report only tenants they hold a
  membership in.
- **1.5** The Identity Service shall report the caller's own email address,
  which requirement 10.3 of `tenant-and-user-management` does not reserve from
  them: it is theirs, and they presented it to sign in.

### 2. And nobody else's

- **2.1** The Identity Service shall report nothing about any person other than
  the caller.
- **2.2** The Identity Service shall report no tenant in which the caller holds
  no membership.
- **2.3** The Identity Service shall provide no operation that reports another
  person's standing.
- **2.4** The Identity Service shall answer a caller who holds no membership
  anywhere with the same shape as one who holds several, so that an empty answer
  is an ordinary answer rather than a signal.

### 3. Who may ask

- **3.1** The Identity Service shall permit this request from any caller whose
  credential resolves to a person, whether or not they hold any membership and
  whether or not they are an operator.
- **3.2** If a machine credential asks for a caller's standing, the Identity
  Service shall refuse the request as it answers a record that does not exist.
- **3.3** If a request presents no credential, the Identity Service shall refuse
  it as it answers a record that does not exist.
- **3.4** The Identity Service shall let a route declare that it admits any
  authenticated person, distinctly from declaring it public, declaring it for a
  platform operator, and declaring it for tenant roles.

### 4. Read when asked, never carried in a credential

- **4.1** When a caller's role in a tenant changes, the Identity Service shall
  report the new role the next time they ask, without their credential changing.
- **4.2** When a caller's membership is revoked or its tenant is deactivated, the
  Identity Service shall omit that tenant the next time they ask.
- **4.3** The Identity Service shall derive a caller's standing from stored
  records only, and shall take nothing but the caller's identity from the
  credential presented.

### 5. Isolation is not the price

- **5.1** The Identity Service shall confine whatever read access this capability
  requires to the caller's own records.
- **5.2** The Identity Service shall not, through this capability, make one
  person's memberships readable by another person or by any tenant-scoped
  caller.
- **5.3** The Identity Service shall leave every existing tenant-scoping rule and
  policy in force, and shall add no way to read a tenant's records from outside
  that tenant.
