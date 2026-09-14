# Guardrails — the design's quality gate

No session can be marked `concluido` without passing this checklist (via `/review` or the closing phase of `/design`). Each item gets one of **five verdicts**: **PASS** (addressed, with justification), **FALHA** (real gap — needs a decision or a conscious out-of-scope note), **N/A** (does not apply, with a reason), `[premissa-a-validar]` (can't be judged yet), or **RISCO ACEITO** (a FALHA the user knowingly decided to carry).

**Third state — `[premissa-a-validar]`**: an item nobody can judge yet (the design doesn't say enough either way). It counts in `guardrails.premissas`, never in `falha` or `pass` — marking it PASS or FALHA anyway would either fake coverage or invent a decision that reaches the next reader looking closed. It only leaves this state once someone actually validates it (it becomes PASS or FALHA); it never resolves itself by turning into a risk, and it never resolves itself by the clock running out.

**Fourth state — RISCO ACEITO**: a FALHA the user chose to carry rather than fix. It counts in `guardrails.riscos`, not in `falha`. Two preconditions are mandatory before an item can carry this verdict: an entry in the scorecard's `risks`, **and** a recorded decision in `40-tradeoffs.md` (options, choice, what's given up, a "Defesa em 30s"). Without both, the item stays FALHA — a risk nobody wrote down isn't accepted, it's just unaddressed. RISCO ACEITO never becomes PASS: accepting a risk doesn't mean the design addresses it.

**Severity is earned by an observed defect.** A blocking item with no traceable failure scenario behind it is personal taste dressed up as a rule — especially in the Domain & Modeling block below, where "I'd have modeled it differently" is not the same thing as a concrete defect.

The gate: `pass + falha + na + premissas + riscos` must equal the total number of items in this file — the lint enforces the closed sum, so an item nobody has judged yet can't silently disappear from the count. `status: "concluido"` is blocked only while `falha > 0`; accepted risks and open premises never block it.

## Availability & Failures
1. **SPOF**: is there a single component whose failure takes down the whole system? (LB, primary database, broker, scheduler…)
2. **Failover**: for each stateful component, what happens when it goes down? How much time and how much loss (RTO/RPO)?
3. **Degradation modes**: does the system degrade gracefully (read-only, growing queue, feature off) or break entirely?
4. **DR**: was the loss of an entire zone/region considered or consciously dismissed?

## Traffic & Scale
5. **Hot spots**: is there a hot key/partition/user that concentrates load? (celebrity problem, partitioning by date…)
6. **Backpressure**: when a consumer slows down, what holds the queue back? Is there a limit, shedding, or does the system drown?
7. **Thundering herd / cache stampede**: was mass cache expiration or mass reconnection handled (jitter, regeneration lock, staggered TTL)?
8. **Growth limits**: does the design hold up at 10x? Which component blows up first, and what would the plan be?

## Data & Consistency
9. **Idempotency**: is every write that can be retried (client retry, queue redelivery) idempotent or deduplicated?
10. **Declared consistency**: where is it strong, where is it eventual — and does the product tolerate eventual's anomalies (read-your-own-write, ordering)?
11. **Data loss**: does the write path ack before or after durability? What can an asynchronous replica lose?
12. **Migrations**: does a schema/partitioning change in production have a zero-downtime path?

## Integrations & Retries
13. **Retry storm**: do retries have exponential backoff + jitter + a limit? Circuit breaker where an external dependency can rot?
14. **Timeouts**: does every network call have an explicit timeout shorter than its caller's timeout?
15. **External contracts**: do third-party dependencies have a fallback, or does their SLA become yours?

## Operations
16. **Minimum observability**: do the 3-4 metrics that detect each failure mode above exist? Does tracing cross the async hops?
17. **Deploy/rollback**: can you revert within minutes? Does a data change track the code rollback?
18. **Cost**: was the most expensive component identified, and is the cost at 10x acceptable?

## Security (baseline)
19. **AuthN/AuthZ** at the system's boundaries; sensitive data encrypted in transit and at rest; rate limiting at public edges.

## Data & Contract (20-29)
20. **Row grain**: is the unit that can fail on its own the same as the row/record the design writes? (a multi-channel notification with one row per channel, when a channel can have several destinations, has no place to record a partial failure)
21. **Contract with backing**: does every field/header/filter the API or contract promises have a column, index, or real source behind it? (an idempotency header with no column and no uniqueness constraint isn't an idempotency guarantee, just a name)
22. **Invariant in the database, not the application**: does the invariant actually hold at the data layer, or only in application code that a second writer can bypass? (a nullable column inside a dedup `UNIQUE` doesn't stop a duplicate — NULLs don't collide)
23. **Explicit time**: does a rule with a deadline ("pending for more than 10 min counts as a failure") have a timestamp column recorded at the right moment to evaluate it?
24. **Derived or stored state**: for every enumerated state, is it clear whether it's stored or derived, who writes it, and how a row exits each state?
25. **Index-backed queries**: does every query the design relies on — foreign keys included — have an index behind it, or does it degrade to a scan as the table grows?
26. **Bounded responses**: does every list-returning endpoint have pagination, a cap, and a worst case sized with real numbers (not just "it returns the list")?
27. **Authorization at the data grain**: is authorization checked at the level of the row/record being touched, not just at the endpoint?
28. **Data lifecycle**: does a stated retention period ("24 months of history") have an actual purge mechanism, including cascade into dependent tables?
29. **Contract compatibility**: can the API/schema evolve without breaking an existing consumer (additive fields, versioning, deprecation path)?

## Domain & Modeling (30-34)
30. **Refuted classification**: was the domain's core classification (what kind of thing each entity is) tested against a real edge case, or just asserted?
31. **Speculative modeling**: does every entity/relationship in the model correspond to a requirement that's actually in scope, or is some of it modeled "in case it's needed later"?
32. **Closed lifecycle and cardinality**: for the domain's core entities, are the lifecycle (every state and transition) and the cardinality of their relationships (1:1, 1:N, N:N) both stated explicitly, not left implicit?
33. **Invariant with a named, existing enforcement point**: does every domain invariant name the specific mechanism that enforces it (a constraint, a lock, a specific line of validation) — and does that mechanism actually exist in the design, not just get asserted?
34. **Term with a single owner**: does every domain term have exactly one bounded context that owns its meaning, with other contexts referencing it rather than redefining it?
