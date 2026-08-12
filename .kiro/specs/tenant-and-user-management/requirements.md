# Requirements — tenant-and-user-management

## Project Description (Input)

### Who has the problem

Two distinct actors, with deliberately different reach:

- **Platform operators** run CubeForge itself. They sit above every tenant and
  are the only actor allowed to bring a new tenant into existence.
- **Tenant administrators** run a single customer organization. They manage the
  people inside their own tenant and nothing beyond it.

A third actor is affected without acting: **tenant members** (editor, viewer),
whose access is entirely determined by records this feature creates.

### Current situation

The API is a bootstrapped skeleton. There is no notion of a tenant, a user, or a
role anywhere in the system — no schema, no persistence, no endpoints. Every
capability on the roadmap depends on records that do not yet exist: there is
nothing to authenticate (feature 2), nothing to authorize (feature 3), and no
owner to attribute transactional data to (feature 5).

The isolation guarantee the platform exists to demonstrate is currently vacuous.
Tenant A cannot read tenant B's data only because neither tenant exists.

### What should change

The system gains the identity records everything downstream is scoped by, and
the ability for the right actors to manage them.

**Tenants** are provisioned exclusively by platform operators. This introduces a
principal that belongs to no tenant, which is the boundary case where isolation
is most likely to break and must therefore be covered explicitly.

**Users** exist once, globally, and reach tenants through **memberships**. A
single user may hold memberships in several tenants, and the role
(admin / editor / viewer) is an attribute of the membership, not of the user.
This is the model that makes the sharpest isolation test possible: the same
principal, holding admin in tenant A, must be rejected when acting on tenant B.

**Tenant administrators** create users inside their own tenant directly,
assigning a role at creation time. No invitation tokens and no email delivery.

**Removal is soft.** Tenants, users and memberships are deactivated rather than
deleted, so referential integrity holds against the transactional data arriving
in later features and the analytical pipeline retains its history.

---

## Subject

Acceptance criteria below use **the Identity Service** as their subject: the
tenant, user and membership management capability of the CubeForge API.

---

## Adjacent Expectations

This feature produces the records other features depend on, and depends on
capabilities it does not own.

**Relies on, does not own:**

- **A resolved caller.** Every criterion below assumes the request arrives with
  an established actor — their identity, their role, and the tenant they are
  acting in. Establishing that principal is authentication (feature 2). Until it
  exists, the acting principal is supplied directly by tests.
- **Reusable enforcement infrastructure.** Applying role checks uniformly across
  routes is authorization (feature 3). This feature specifies *what* must be
  permitted and denied; it does not own the mechanism.
- **Foundational request handling** — validation, error reporting and request
  correlation (feature 0).

**Explicitly out of scope:** credential storage, token or key issuance,
self-service signup, invitation flows, email delivery, password recovery,
permanent deletion, and data retention policy.

**Deferred to a later iteration**, deliberately rather than by omission:
changing a person's email address, renaming a tenant, reactivating a
deactivated tenant, person or membership, and any limit on how many people a
tenant may hold. None of these change the properties this feature exists to
demonstrate, so they are not worth the scope now.

---

## Requirements

### 1. Tenant provisioning

Only platform operators bring tenants into existence.

- **1.1** When a platform operator submits a tenant creation request with a name unique
  across the platform, the Identity Service shall create an active tenant and
  return its identifier.
- **1.2** If a tenant creation request omits a required attribute or supplies a name
  already in use, the Identity Service shall reject the request and report which
  attribute is invalid.
- **1.3** If an actor who is not a platform operator submits a tenant creation request,
  the Identity Service shall deny the request.
- **1.4** The Identity Service shall record the creation time of every tenant.

### 2. Tenant deactivation

Tenants are retired without destroying history.

- **2.1** When a platform operator deactivates a tenant, the Identity Service shall mark
  the tenant inactive and retain the tenant, its members and their memberships.
- **2.2** While a tenant is inactive, the Identity Service shall deny every request made
  in the context of that tenant, regardless of the caller's role.
- **2.3** The Identity Service shall never permanently remove a tenant, a user, or a
  membership.
- **2.4** If a platform operator deactivates a tenant that is already inactive, the
  Identity Service shall leave the tenant unchanged and report success.

### 3. Platform operator boundary

Isolation applies upward, not only sideways. An operator administers tenants as
containers and cannot see inside them.

- **3.1** The Identity Service shall permit platform operators to create, list and
  deactivate tenants, and to deactivate a user by their platform-wide
  identifier.
- **3.2** If a platform operator requests the members of a tenant, the memberships held
  by a user, or any business data belonging to a tenant, the Identity Service
  shall deny the request.
- **3.3** The Identity Service shall exclude any indication of which tenants a user
  belongs to from every response returned to a platform operator.

### 4. User creation within a tenant

A person exists once on the platform and may belong to several tenants, so
"create a user" is really "give this person a membership here".

- **4.1** When a tenant administrator creates a user with an email address not yet known
  to the platform, the Identity Service shall create the person, grant them a
  membership in the administrator's tenant with the specified role, and return
  the resulting member.
- **4.2** When a tenant administrator creates a user with an email address already known
  to the platform, the Identity Service shall grant a membership in the
  administrator's tenant and return a result indistinguishable from the case
  where the person did not previously exist.
- **4.3** The Identity Service shall not disclose, through response content, wording, or
  observable timing, whether an email address was already known to the platform.
- **4.4** If the email address already holds an active membership in the administrator's
  own tenant, the Identity Service shall reject the request and report that the
  person is already a member of this tenant.
- **4.5** If a tenant administrator supplies a role outside admin, editor and viewer, the
  Identity Service shall reject the request and report the permitted roles.
- **4.6** If an actor who is not an administrator of the target tenant attempts to create
  a user in it, the Identity Service shall deny the request.

Criterion 4.3 is the reason 4.2 exists: revealing that an
address is already registered would tell one customer that a named person is a
customer of another, which is a cross-tenant disclosure through a side channel
rather than through data access.

### 5. Roles and memberships

- **5.1** The Identity Service shall associate exactly one role — admin, editor or
  viewer — with every membership.
- **5.2** The Identity Service shall allow the same person to hold different roles in
  different tenants simultaneously.
- **5.3** When a tenant administrator changes the role of a member of their own tenant,
  the Identity Service shall apply the new role to that membership only, leaving
  the person's memberships in other tenants unchanged.
- **5.4** While an actor is acting in the context of a tenant, the Identity Service shall
  determine their permissions solely from the membership they hold in that
  tenant.

### 6. Membership revocation

Losing access to one tenant must not affect the others.

- **6.1** When a tenant administrator revokes a membership in their own tenant, the
  Identity Service shall mark that membership inactive and leave the person's
  memberships in other tenants active.
- **6.2** While a membership is inactive, the Identity Service shall deny every request
  that person makes in the context of that tenant.
- **6.3** If a tenant administrator attempts to revoke a membership in a tenant they do
  not administer, the Identity Service shall deny the request.

### 7. Last administrator protection

A tenant nobody can administer can only be repaired outside the product, which
contradicts the operator boundary in requirement 3.

- **7.1** If revoking a membership would leave its tenant with no active administrator,
  the Identity Service shall reject the request and report that the tenant must
  retain at least one administrator.
- **7.2** If changing a member's role would leave their tenant with no active
  administrator, the Identity Service shall reject the request and report the
  same constraint.

### 8. Platform-wide user deactivation

- **8.1** When a platform operator deactivates a person by their platform-wide
  identifier, the Identity Service shall deny every subsequent request from that
  person in every tenant, while retaining their memberships.
- **8.2** The Identity Service shall retain a deactivated person's records so that data
  they previously created remains attributable.
- **8.3** If a tenant administrator attempts to deactivate a person platform-wide, the
  Identity Service shall deny the request.

### 9. Tenant isolation

The property the platform exists to demonstrate. It must hold for every actor
and every role, without exception.

- **9.1** While an actor is acting in the context of a tenant, the Identity Service shall
  restrict every read and every write to records belonging to that tenant.
- **9.2** If an actor references a tenant, person or membership belonging to a tenant
  they hold no active membership in, the Identity Service shall respond as though
  the referenced record does not exist, rather than indicating that access was
  refused.
- **9.3** Where a person holds memberships in more than one tenant, the Identity Service
  shall never allow a membership in one tenant to grant any access in another.

Criterion 9.2 is deliberate: distinguishing "forbidden" from "not found"
would let a caller confirm that a given identifier exists somewhere on the
platform, which is itself a cross-tenant leak.

### 10. Listing and retrieval

- **10.1** When a tenant administrator lists the members of their own tenant, the Identity
  Service shall return only people holding a membership in that tenant, and shall
  indicate for each whether their membership is active.
- **10.2** While a person's membership is inactive, the Identity Service shall exclude
  them from member listings unless inactive members are explicitly requested.
- **10.3** The Identity Service shall expose a person's email address only to
  administrators of a tenant in which that person holds a membership.
