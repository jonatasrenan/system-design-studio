# Guardrails — the design's quality gate

No session can be marked `concluido` without passing this checklist (via `/review` or the closing phase of `/design`). Each item gets **PASS** (addressed, with justification), **FALHA** (real gap — needs a decision or a conscious out-of-scope note), or **N/A** (does not apply, with a reason).

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
