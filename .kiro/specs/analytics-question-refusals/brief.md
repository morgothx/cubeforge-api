# Brief — analytics-question-refusals

*Measured against the running platform on 2026-10-01, from `cubeforge-web`'s
explorer. Raised by the feature-level validation of `dashboard-analytics`,
which found this and routed it here rather than working around it downstream.*

## Who has the problem

- **A person composing a question in the dashboard's explorer.** They tick
  three measures and five groupings — every one of them offered to them by this
  platform's own vocabulary route — and are told *"The service could not be
  reached. Please try again."* beside a retry button. Both halves are false:
  the service answered, and it will answer identically for as long as the
  question stands. Pressing the button spends another of the ten questions a
  minute the platform allows and returns the same refusal.
- **Whoever is on call.** `model-rejected` is logged as an analytics failure
  and answered `503`, the same as a semantic layer that is not running. One of
  those is an outage and the other is a question nobody can ask. An alert that
  cannot tell them apart sends somebody to look at a container that is
  perfectly healthy.
- **`dashboard-analytics`, which cannot fix this itself.** Its requirement 9.3
  makes the platform the only authority on what may be asked, and the
  vocabulary publishes no such restriction. For the dashboard to refuse this
  combination on its own, it would have to invent a rule the platform never
  stated — which is exactly the copy of the platform's answer that the
  vocabulary route was built to eliminate.

## Current situation

The semantic layer models `on_hand_quantity` as a rolling-window measure, and
the engine requires exactly one time dimension when one appears. Asking it
alongside **both** day groupings is therefore impossible to compose:

```
POST /tenants/:id/analytics/questions
{ "measures": ["on_hand_quantity"],
  "groupings": ["recorded_day", "occurred_day", "kind", "product", "location"],
  "from": "2026-09-02", "to": "2026-10-01", "by": "recorded" }

503  { "statusCode": 503, "message": "the answer is unavailable",
       "reason": "model-rejected" }
```

The engine's own words, in the API's log and never in the response:

```
Error: the semantic layer refused:
{"error":"Error: Rolling window requires one time dimension and equal date ranges"}
```

Narrowed by measurement: `net_quantity` with those same five groupings answers
in full; `on_hand_quantity` with one day grouping answers; `on_hand_quantity`
with `product` and `location` answers. The refusal is specific to a cumulative
measure asked alongside both day groupings.

`analytics-failure.ts` already classifies this correctly in its own vocabulary.
`model-rejected` is documented there as *"a question the model refused to
compose"* — a property of the question — and is deliberately kept distinct from
`model-unreachable`. The classification is right; what is wrong is where it
ends up. `analytics-failure.filter.ts` maps **every** analytics failure to
`503`, and that reading of the taxonomy is what reaches the person.

The over-long period is already handled the other way, and well: it is a `400`
carrying a sentence and a `field`, and the dashboard shows it as written.

## What should change

- **A question the model cannot compose is refused as a question, not reported
  as an unavailable service.** It is about what was asked; it is reproducible;
  and the person can act on it. That makes it a rejection, alongside the
  over-long period, and leaves `503` to mean what it says.
- **The sentence must be the platform's own.** The engine's error text may not
  be forwarded: `analytics-failure.ts` already warns that a query layer's error
  body regularly carries the statement it generated, which would put a
  generated query — and where the data lives — in front of a person. The
  platform has to say what is wrong in its own words, from what it knows about
  its own model, without quoting the engine.
- **`field: "question"` is the target contract.** `cubeforge-web`'s
  `endpoints.ts` shows a `400` with `field` `question` or `period` verbatim, and
  turns every other rejection into a refusal that blames nobody and offers no
  remedy. A person who ticked two day groupings *can* fix it by unticking one,
  so the actionable wording is the right one — and with that field, **the
  dashboard needs no change at all.**
- **Operators keep the distinction they already have.** `model-rejected` stays
  its own class in the log; what changes is that it stops being answered as an
  outage.

## Scope decisions to settle in requirements

- **Which restrictions this covers.** The rolling-window rule is the one
  measured. Whether the platform enumerates its model's restrictions, or
  recognises a refusal from the engine and translates it, is the central
  question — the first is knowable in advance and testable without the engine;
  the second cannot be complete and depends on matching an engine's wording,
  which this codebase already treats as a mistake worth avoiding.
- **Whether the vocabulary should publish the restriction.** If it did, the
  dashboard could refuse the combination before spending a question, and say so
  in the composer. That is `analytics-vocabulary`'s territory and a separate
  change; it would be prevention, where this spec is the correction. The
  correction is needed either way, because a dashboard is not the only possible
  caller.
- **Out of boundary:** the dashboard (no change needed under the proposed
  contract), the vocabulary's shape, and anything about when data is exported.

## Boundary candidates

- **Owned:** the classification of an analytics failure into an HTTP answer,
  the wording of a question the model cannot compose, and whatever knowledge of
  the model's restrictions that wording requires.
- **Adjacent, and unchanged:** `analytics-vocabulary` (what may be asked),
  `cube-semantic-layer`'s model itself (the rolling window is correct as
  modelled), and the dashboard.

## Evidence

Reproduced from `cubeforge-web`'s explorer and directly against the route, with
tenant Northwind on a local stack: five movements recorded through the sync API
and exported. Recorded in `dashboard-analytics`'s `tasks.md` under 6.2, and in
the validation that raised this.
