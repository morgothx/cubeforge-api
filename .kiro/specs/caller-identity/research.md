# Research — caller-identity

Discovery type: **light**. Everything this feature needs already exists in some
form; what had to be found is which existing pattern each of the four gaps
extends, and what breaks when they do.

No dependency is added.

---

## Investigations

### 1. Reading one person's memberships — the shape of the answer

Three identities, none of which can do it today:

| Identity | On `memberships` |
|---|---|
| `cubeforge_app` | grant, but `memberships_app_all` pins it to `tenant_id = current_tenant_id()` |
| `cubeforge_authenticator` | no grant; a test asserts `permission denied for table memberships` |
| `cubeforge_operator` | no grant, and migration 0001 says the absence is the point |

Options considered:

| Option | Verdict |
|---|---|
| Loop tenants with the app identity | Circular. Knowing which tenants to publish is the question being asked |
| `SECURITY DEFINER` function, like `find_or_create_person` | Works, and the pinned `search_path` ceremony is already established here — but it moves the confinement into a function body, where a later edit can widen it silently |
| **Publish the person, and let a policy confine the read** | **Adopted.** See below |

The database already has exactly this mechanism for tenants:

```sql
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $$;
```

A `current_person_id()` reading `app.current_person` mirrors it exactly, and a
policy `USING (person_id = current_person_id())` confines the authenticating
identity to the caller's own rows **in the database**, not in the query. That is
what makes requirements 5.1 and 5.2 structural: a query that forgot its
predicate still returns only the caller's memberships, and the existing
second-isolation-layer suite can prove it the same way it proves the tenant
case.

The authenticating identity can already read `people` (migration 0008) and
`tenants` (0009), so only `memberships` needs anything new.

### 2. The transaction has nowhere to publish a person

`runAuthenticating` opens a transaction and publishes nothing — correctly, since
sign-in runs before any person is known. A second entry point is needed:
`runAsPerson(personId, work)`, publishing `app.current_person` with the
transaction-local form of `set_config`, exactly as the tenant-scoped unit of
work does and for the same reason: connections are pooled, and a session-level
setting would leak the person into whatever request picked the connection up
next.

### 3. The missing actor kind, and what it costs

`ActorContext` has three kinds and none of them is "a person, acting in no
tenant". A fourth is needed. The union is switched on with an
`unreachable(value: never)` default in several places, so **the compiler will
name every site that has to decide what the new kind means** — which is the
argument for adding a kind rather than making `tenantId` nullable on
`tenant-member`, where every existing check would silently keep compiling and
quietly start being wrong.

### 4. The resolver change breaks one existing test, knowingly

Today, on a path that names no tenant, a non-operator resolves to `null`. After
this feature they resolve to a person. Both are refused on an operator route,
with the same 404 — but the **log line changes**, from

    not-found: this route needs a principal and none was resolved

to a refusal naming the caller's kind. One test depends on the old line: the
role matrix's `is the guard that refuses, not only the use case behind it`,
which uses a tenant member on `GET /tenants` precisely because it produced the
guard's no-principal message.

That probe has to be re-aimed. It is not a regression — it is the test noticing
that the thing it probed changed meaning, which is what it was for.

### 5. Deactivation must still end access

A person deactivated platform-wide holds a token that verifies until it expires.
Resolving a person principal therefore has to check that they are active, the
way `isOperator` now does. Feature 2's requirement 6.1 says deactivation rejects
token issuance and refresh; feature 3's matrix proves a deactivated person is
refused inside a tenant. Neither covers a tenantless route, because until now
there were none a plain person could reach.

---

## Synthesis

### Generalization

Publishing a person into a transaction is the same mechanism as publishing a
tenant, and the second one should look like the first: a `STABLE` function, a
policy that reads it, and `set_config(..., true)`. Nothing about it is specific
to this feature — a later capability that needs "this person's rows across
tenants" inherits it.

### Build vs adopt

Everything is adopted from this repository's own established patterns:
transaction-local settings, a policy-based confinement, an actor union with an
exhaustive switch, the access declaration. No library is added, and no new
concept is invented where an existing one extends.

### Simplification

- **No caching.** The whole point of the feature is that the answer is read when
  asked; a cache would reintroduce the staleness that made a JWT claim wrong.
- **No `GET /people/:id` sibling.** Requirement 2.3 forbids it, and building the
  general "someone's standing" and restricting it to self would be an interface
  that invites the widening it exists to prevent.
- **No operator listing.** An operator asking for their standing gets their own
  memberships, not every tenant; `GET /tenants` already answers that and is
  already declared for them.

---

## Risks

| Risk | Mitigation |
|---|---|
| The new policy widens what the authenticating identity can read | The policy names `person_id = current_person_id()`, and with no person published it matches nothing. Asserted by querying `memberships` as the authenticator with nothing published, and with another person published |
| A forgotten `set_config` returns an empty list rather than failing | Same failure shape the tenant case has, and the same answer: the isolation suite asserts the unpublished case returns zero rows, so "silently empty" is a tested behaviour rather than a surprise |
| Adding an actor kind ripples further than expected | The exhaustive switches turn the ripple into compile errors, which is cheaper to survey than to search for |
| The re-aimed matrix probe becomes weaker | Its purpose is to distinguish the guard from the use case behind it; any refusal the guard alone produces serves. The undeclared-route probe in the guard's own suite is unaffected |

---

## Revalidation triggers

- A capability needs another person's memberships — the confinement here is
  deliberately unable to express it, and widening the policy would be the wrong
  fix.
- Machine callers gain a standing of their own in feature 5.
- A route needs both "any person" and a tenant in its path, which this
  feature's declaration shape does not combine.
