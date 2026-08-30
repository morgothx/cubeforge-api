# Product

*Updated: 2026-08-29*

## What this is

CubeForge is a multi-tenant SaaS analytics platform. Customer organizations
("tenants") record transactional data through the API, and their users explore
that data through a dashboard backed by a semantic layer that defines every
business metric exactly once.

This repository is the API and data pipeline. The dashboard lives in the
companion `cubeforge-web` repository.

## Why it exists

It is a portfolio project, built to demonstrate skills for full-stack roles
requiring AWS, multi-tenancy, and embedded BI. Both repositories are public and
read as production code, which changes what "done" means here: a feature is not
finished when it works, it is finished when a reviewer reading the diff would
call it production-grade.

The practical consequence is that the interesting parts are not the CRUD
endpoints. They are the properties that are hard to retrofit and easy to get
subtly wrong:

- **Tenant isolation** — tenant A must never be able to read or write tenant B's
  data, through any endpoint, under any role.
- **Role-based authorization** — admin, editor and viewer, enforced before
  business logic runs.
- **A mixed OLTP/OLAP pipeline** — transactional writes and analytical reads are
  deliberately served by different engines.

Each of those must be defensible in an interview with a real reason, not a
best-practice slogan. Steering, specs and code should all reflect the reasoning,
not just the outcome.

## Core capabilities

- **Tenant and user management** — provisioning tenants, users, and role
  assignments.
- **Authentication** — two mechanisms on purpose: JWT for dashboard users, API
  keys for machine-to-machine callers.
- **Authorization** — role checks and tenant scoping applied as infrastructure,
  never per-route by hand.
- **Transactional API** — idempotent, rate-limited, validated endpoints suitable
  for retrying clients and upstream ERP-style integrations.
- **Analytical pipeline** — export of historical data to columnar storage,
  partitioned by tenant and by day, so heavy analysis never touches the
  transactional database. It runs today as an operator command; *when* it runs
  is a deployment decision, deliberately not a cron inside the API process.
- **Semantic layer** — business metrics defined once and served to the frontend,
  rather than re-implemented per chart.

## Who uses it

- **Tenant users** (admin / editor / viewer) — reach the platform through the
  dashboard. What they can see and do is decided server-side by role and tenant.
- **Machine callers** — upstream systems pushing transactional data through
  authenticated, idempotent endpoints. They retry; the API must tolerate it.

## What success looks like

- A cross-tenant read is impossible, and there is a test proving it for every
  role and every tenant-owned resource.
- Replaying any mutating request produces no duplicate effects.
- Analytical load cannot degrade transactional performance, because they do not
  share an engine.
- A reviewer can answer "why is it built this way?" from the repository alone.

## Disclosure rules

What a caller may *learn* is part of the product, not an implementation detail.
Two rules apply platform-wide and every feature inherits them:

- **Refusal is indistinguishable from absence.** Referencing a record in a tenant
  the caller has no active membership in returns the same response as
  referencing an identifier that exists nowhere. Distinguishing them would let a
  caller confirm that an identifier exists somewhere on the platform — a
  cross-tenant leak through the error channel rather than through data.
- **Existing elsewhere is not observable.** Adding a member whose email is
  already registered in another tenant must be indistinguishable from adding an
  unknown one, in status, body and the work performed. Otherwise one customer
  learns that a named person is a customer of another.

## Known gaps

**Both gaps recorded here on 2026-08-13 are closed.** Provisioning a tenant now
names its first administrator and reports who that turned out to be, so no
membership is written by hand; and the acting principal is resolved from a
verified bearer token or API key rather than read from a header and believed.
Recorded rather than deleted, because "the principal used to be trusted input"
explains why the resolver is shaped the way it is.

What is genuinely open is one thing:

- **The exported data has no reader yet.** Movements and catalogue land in
  object storage as Parquet, partitioned for a query engine, and nothing queries
  them. That is the next feature's to close, and the layout was chosen for it.

## Explicit non-goals

- Not a real AWS deployment. Everything targets a local emulator; real
  deployment would be a deliberate, human-approved step.
- Not a general-purpose BI tool. The semantic layer models this product's
  domain, not arbitrary customer schemas.
- Not server-rendered. The dashboard is a static SPA by design.
