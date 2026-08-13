# Requirements — authentication

## Project Description (Input)

### Who has the problem

- **Tenant users** (admin, editor, viewer) reach the platform through the
  dashboard. Today nothing establishes who they are: the acting principal is
  read from request headers, so any caller can claim to be any person in any
  tenant.
- **Machine callers** — upstream systems that will push transactional data in
  feature 5 — have no way to authenticate at all.
- **Platform operators** cannot bring a tenant into a usable state. Creating a
  member requires an administrator to already exist, so the first membership of
  every tenant has to be written directly into the database.

### Current situation

Feature 1 built the identity records and every rule that depends on them:
tenants, people, memberships, roles, and two independent layers of tenant
isolation proven across the role matrix. All of it consumes an `ActorContext`
that states who is acting and in which tenant.

That context is produced by a provisional middleware that trusts request
headers completely. It refuses to be constructed when `NODE_ENV=production`,
which is the only thing currently preventing a total authentication bypass. The
authorization work of feature 3 cannot begin on top of a principal nobody
verified.

Two consequences are already visible in the code: `test/integration` seeds each
tenant's first administrator with raw SQL because no route can, and
`actor-context.middleware.ts` exists solely to be deleted by this feature.

### What should change

The system gains verified principals, and the provisional middleware is removed.

**Dashboard users authenticate with a password and receive two tokens.** A
short-lived access token carries the claim; a longer-lived refresh token, whose
state lives in the database, can be revoked.

**The access token identifies the person, never the tenant.** A person may hold
memberships in several tenants with different roles, so the tenant continues to
come from the request path and the membership is resolved per request. A token
that asserted a tenant would also assert a membership that may since have been
revoked.

**Credentials belong to the person, not to the membership**, because a person
exists once platform-wide. Setting a password is therefore a flow of its own,
never part of creating a member — a direct consequence of requirement 4.3 of
feature 1.

**Only platform operators may establish a credential.** A credential is
platform-wide, so letting an administrator of one tenant set it would let them
seize an account that administers another. No arrangement of "only if the person
has none yet" avoids this without the refusal itself disclosing that the person
exists elsewhere.

**Machine callers authenticate with API keys**, issued by an administrator
inside their own tenant and scoped to it.

**Provisioning a tenant also establishes its first administrator**, closing the
bootstrap gap.

Authentication answers *who the caller is*. It does not decide what they may do:
role enforcement remains feature 3's.

---

## Subject

Acceptance criteria below use **the Authentication Service** as their subject:
the credential, session and principal-resolution capability of the CubeForge
API.

---

## Adjacent Expectations

**Relies on, does not own:**

- **The identity records** — people, tenants, memberships and their statuses are
  feature 1's. This feature reads them and creates none except the bootstrap
  membership in requirement 8.
- **Role enforcement.** This feature establishes *who* a caller is and, for
  machine callers, which tenant and role their credential carries. Deciding
  whether that principal may perform an operation is feature 3, and this feature
  does not build reusable enforcement for it.
- **The disclosure rules** stated in product steering — refusal indistinguishable
  from absence, and existing elsewhere not observable — apply here unchanged and
  are not restated as new obligations.

**Explicitly out of scope:** multi-factor authentication, single sign-on and
federated identity, password expiry and rotation policy, self-service password
recovery, remembered devices, session listing and per-device revocation, and
changing a person's email address.

**Accepted risk, stated rather than mitigated:** a platform operator can issue a
setup token for any person and therefore seize any account, including one that
administers a tenant. This follows from operators being the only actor above all
tenants; the alternative delegations were worse. Requirement 1.5 makes a seizure
observable to the victim by ending their sessions, and requirements 11.6 and
12.2 record who did it.

---

## Requirements

### 1. Credential establishment

A password belongs to a person, and only a platform operator may set one in
motion.

- **1.1** When a platform operator requests credential setup for a person by their
  platform-wide identifier, the Authentication Service shall issue a single-use
  setup token with a validity period of at most 24 hours and return it once.
- **1.2** When a person redeems a valid setup token together with a new password,
  the Authentication Service shall establish that password as their credential
  and invalidate the token.
- **1.3** If a setup token is presented after being redeemed, after its validity
  period, or with a value never issued, the Authentication Service shall reject
  the request with a single response that does not indicate which of those
  conditions applied.
- **1.4** The Authentication Service shall accept passwords of at least 12
  characters and shall impose no composition rules.
- **1.5** When a person's credential is established or replaced, the
  Authentication Service shall invalidate every refresh token that person holds.
- **1.6** If an actor who is not a platform operator requests credential setup,
  the Authentication Service shall deny the request.
- **1.7** The Authentication Service shall provide no operation that returns or
  reveals an established password.

### 2. Signing in

- **2.1** When a person submits an email address and a password matching their
  established credential, the Authentication Service shall issue an access token
  and a refresh token.
- **2.2** If the address is unknown to the platform, has no established
  credential, or the password does not match, the Authentication Service shall
  reject the request with one response identical in status, body and wording for
  all three.
- **2.3** While a person is deactivated platform-wide, the Authentication Service
  shall reject their sign-in with the same response as 2.2.
- **2.4** While a person holds no active membership in any tenant, the
  Authentication Service shall issue tokens as in 2.1.

Criterion 2.4 separates the two questions this feature exists to keep apart:
holding no membership says nothing about who someone is. Refusing to
authenticate them would also make the response differ by membership, which is
exactly the kind of inference the disclosure rules forbid.

### 3. Access tokens

- **3.1** The Authentication Service shall issue access tokens that identify the
  person and name no tenant.
- **3.2** The Authentication Service shall issue access tokens that expire within
  15 minutes of issuance.
- **3.3** When a request presents an access token that is valid and unexpired, the
  Authentication Service shall establish the acting person for that request.
- **3.4** If a request presents a token that is absent, malformed, expired, or not
  verifiable as issued by this platform, the Authentication Service shall
  establish no principal for that request.
- **3.5** The Authentication Service shall exclude a person's email address, roles
  and tenant memberships from the contents of an access token.

### 4. Refreshing a session

- **4.1** When a valid refresh token is presented, the Authentication Service shall
  issue a new access token and a new refresh token, and invalidate the presented
  one.
- **4.2** If a refresh token that has already been exchanged is presented again,
  the Authentication Service shall reject the request and invalidate every
  refresh token descended from the same sign-in.
- **4.3** The Authentication Service shall reject refresh tokens more than 14 days
  after the sign-in they descend from, regardless of how recently they were
  issued.
- **4.4** If a refresh token is expired, invalidated or unrecognized, the
  Authentication Service shall reject it with a single response that does not
  indicate which.

### 5. Ending a session

- **5.1** When a person signs out, the Authentication Service shall invalidate the
  refresh tokens of that sign-in.
- **5.2** When a person signs out everywhere, the Authentication Service shall
  invalidate every refresh token they hold.
- **5.3** While the refresh tokens of a sign-in are invalidated, the Authentication
  Service shall continue to accept an already-issued access token of that
  sign-in until it expires.

Criterion 5.3 states the cost of the design rather than hiding it, and is why
3.2 bounds the access token to minutes. Denying a person whose access has been
withdrawn is immediate for a different reason: authorization resolves the
membership from stored records on every request, which is feature 1's behavior
and unchanged here.

### 6. Deactivation ends access

- **6.1** While a person is deactivated platform-wide, the Authentication Service
  shall reject every attempt to issue or refresh tokens for them.
- **6.2** When a person is deactivated platform-wide, the Authentication Service
  shall invalidate every refresh token they hold.
- **6.3** While a tenant is inactive, the Authentication Service shall reject every
  request presenting a credential scoped to that tenant.

### 7. API keys for machine callers

- **7.1** When a tenant administrator issues an API key with a label and a role
  from the permitted set, the Authentication Service shall create a key scoped to
  that administrator's tenant and return its secret exactly once.
- **7.2** The Authentication Service shall provide no operation that returns an
  API key secret after issuance.
- **7.3** When a request presents a valid API key, the Authentication Service shall
  establish a machine principal acting in that key's tenant with that key's role.
- **7.4** If a request presenting an API key addresses a tenant other than the
  key's, the Authentication Service shall answer as though the addressed record
  does not exist.
- **7.5** When a tenant administrator lists the API keys of their tenant, the
  Authentication Service shall return each key's label, role, creation time and
  last use, and shall exclude its secret.
- **7.6** When a tenant administrator revokes an API key, the Authentication
  Service shall reject every subsequent request presenting it.
- **7.7** If an actor who is not an administrator of the tenant attempts to issue,
  list or revoke that tenant's API keys, the Authentication Service shall deny the
  request.
- **7.8** The Authentication Service shall record the time an API key was last used
  successfully.
- **7.9** While the administrator who issued an API key no longer holds an active
  membership in its tenant, the Authentication Service shall continue to accept
  that key.

Criterion 7.9 is a decision, not an omission: a key belongs to the tenant, not
to the person who created it. Revoking keys when an administrator leaves would
break running integrations at the least predictable moment. Requirement 7.5
exists so the remaining administrators can see what they have inherited.

### 8. Provisioning a tenant with its first administrator

This amends requirement 1 of feature 1, which creates a tenant nobody can
administer.

- **8.1** When a platform operator provisions a tenant with a name and an
  administrator email address, the Authentication Service shall create the
  tenant, resolve or create that person, and grant them an active administrator
  membership.
- **8.2** If the tenant name is already in use, the Authentication Service shall
  reject the request and create neither the tenant nor the membership.
- **8.3** The Authentication Service shall return a response identical in status
  and body whether or not the administrator's address was already known to the
  platform.
- **8.4** The Authentication Service shall establish no credential as part of
  provisioning.

### 9. Resistance to guessing

- **9.1** If sign-in attempts for one email address, or from one origin, exceed a
  configured rate, the Authentication Service shall reject further attempts for a
  cooling period.
- **9.2** The Authentication Service shall never disable a person's account as a
  consequence of failed sign-in attempts.
- **9.3** If setup-token redemptions from one origin exceed a configured rate, the
  Authentication Service shall reject further redemptions for a cooling period.
- **9.4** While an address is being throttled, the Authentication Service shall
  respond identically whether or not that address is known to the platform.

Criterion 9.2 is deliberate: disabling an account after failed attempts turns a
known email address into a denial-of-service weapon against its owner, and the
disabling itself would confirm the address exists.

### 10. Every principal is verified

- **10.1** The Authentication Service shall establish an acting principal only from
  a credential it has verified.
- **10.2** The Authentication Service shall provide no mechanism by which a request
  can assert its own principal.
- **10.3** If a request carries no credential, the Authentication Service shall
  establish no principal, and the request shall be answered as though the
  referenced record does not exist.

### 11. Platform operators are people

Feature 1 modelled the operator as a kind of actor with no identity, because
nothing then needed to know which one was acting. Requiring every principal to
come from a verified credential makes that untenable: there is no credential
without someone to hold it.

- **11.1** The Authentication Service shall treat a person as a platform operator
  only while they are recorded as one.
- **11.2** When a person recorded as a platform operator presents a valid access
  token, the Authentication Service shall establish a platform-operator principal
  that identifies that person.
- **11.3** While a person is not recorded as a platform operator, the
  Authentication Service shall never establish a platform-operator principal for
  them, whatever the request claims.
- **11.4** When a person's operator status is withdrawn, the Authentication
  Service shall stop establishing operator principals for them from the next
  request onward, without requiring their tokens to expire.
- **11.5** The Authentication Service shall provide no operation that grants
  platform-operator status.
- **11.6** The Authentication Service shall record which operator performed each
  operator action.

Criterion 11.5 places the root of trust outside the API: the first operator is
granted by an act against the database, by whoever already controls migrations.
An API that could promote its own callers to operator would have no ceiling.

### 12. What is recorded, and what is not

- **12.1** The Authentication Service shall exclude passwords, tokens and API key
  secrets from every log entry.
- **12.2** When authentication fails, the Authentication Service shall record the
  cause and the correlation identifier of the request while returning a response
  that discloses neither.
