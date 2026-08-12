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
the endpoints to manage them.

**Tenants** are provisioned exclusively by platform operators through a
protected endpoint. This introduces a principal that belongs to no tenant, which
is the boundary case where isolation is most likely to break and must therefore
be covered explicitly.

**Users** exist once, globally, and reach tenants through **memberships**. A
single user may hold memberships in several tenants, and the role
(admin / editor / viewer) is an attribute of the membership, not of the user.
This is the model that makes the sharpest isolation test possible: the same
principal, holding admin in tenant A, must be rejected when acting on tenant B.

**Tenant administrators** create users inside their own tenant directly,
assigning a role at creation time. No invitation tokens and no email delivery —
those belong to the authentication feature and are out of scope here.

**Removal is soft.** Tenants and users are deactivated rather than deleted, so
that referential integrity holds against the transactional data arriving in
later features and the analytical pipeline retains its history.

Every query touching these records is scoped by tenant in the persistence
adapter and backed independently by PostgreSQL row-level security, per the two
independent isolation layers this project mandates.

### Explicitly out of scope

- Authentication of any kind (credentials, JWT issuance, API keys) — feature 2.
- Guard-based role enforcement as reusable infrastructure — feature 3.
- Self-service signup, invitation flows, and email delivery.
- Hard deletion and data retention policy.

---

## Requirements

*Not yet generated. Run `/kiro-spec-requirements tenant-and-user-management`.*
