---
name: review
description: Adversarial review of a system design against the guardrails (classic failure classes) — marks PASS/FALHA/N-A per item and blocks completion with open failures. Use when the user types /review or before closing out a design.
---

# /review — adversarial review (guardrails)

You are a skeptical staff engineer doing a design review. Goal: find flaws before the design is declared done.

## Two modes

- **Light** (explicit `--leve`; pass 1's closing in the `design` skill runs this procedure inline, without invoking this skill): run `node tools/check.mjs <slug> --lint` and treat the output as ready-made verdicts; then go through the checklist quickly, reporting in detail only the **3-5 failures an interviewer would raise** — the rest become a one-line verdict. **No gate**: a failure doesn't block sharing; the user fixes the cheap ones (default proposal per item) and sends the expensive ones to "Decisões adiadas" in the trade-offs with a 30s defense. Skip the fine-grained coverage checks (full sheet, "Defesa em 30s", cost with assumptions) — that's the full mode's job. `45-review.md` **doesn't describe itself**: no preamble about the type/scope of the review ("preliminary review", "the full one comes later during polish") — the file goes straight to the verdicts; whatever was left out already lives in "Decisões adiadas" (the CLAUDE.md "no process voice" rule).
- **Full** (default for explicit `/review` and mandatory for `status: "concluido"`): everything below.

1. Resolve the target session (active in the conversation; otherwise ask). **If the session was run in THIS conversation, use the context — re-read only `guardrails.md` and whatever wasn't covered in the conversation**; in a new conversation, read all its files + the root `guardrails.md`.
2. Go through **every item** in the checklist against the real design. For each one:
   - **PASS**: the design addresses it — cite where/how.
   - **FALHA**: a concrete gap — describe the specific failure scenario for this design ("if the consumer reprocesses the payment event, it charges twice"), not a generic one.
   - **N/A**: doesn't apply, with a one-line reason.
   Be truly adversarial: look for the scenario that breaks it, not confirmation of what's good.
3. **Mechanical lints belong to the tool, not to you**: run `node tools/check.mjs <slug> --lint` — it deterministically checks diagram↔components/costs coverage, subgraphs, queues without a declared failure destination (DLQ/reprocessing/"accepted loss"), flow numbering starting at the user's arrival, zoom budget (~15 nodes, labels ≤3 lines), taxonomy emojis, actors beyond the end user, "Defesa em 30s", and internal jargon. Fold the lint's FALHAs and warnings straight into the verdicts, without re-checking them. Spend your judgment only on what's semantic: **an inverted edge direction** (a response drawn as if it were the initiative — e.g., "CDN → service: polling" when it's the client doing the querying) is a legibility FALHA; a secondary role with a numbered edge competing with the main flow, niche jargon without a gloss on first use ("overselling", "thundering herd"…), and a component named only by the vendor brand without the concept ("DynamoDB" instead of "managed KV store (e.g., DynamoDB)") are warnings; missing `why`/`rejected` on a component born from a real decision is a warning. At the end, update the `guardrails` block via `node tools/scorecard.mjs <slug> set-guardrails` (stdin: counts + a summary of each FALHA in `falhas`) — that's what shows up in the Overview.
4. Write `45-review.md` in the session: a summary table (item · verdict · one line) + FALHA details with a suggested direction (without solving it for the user in studio mode; in an already-graded interview session, you can spell out the solution).
5. **Gate**: as long as there's a FALHA that hasn't been addressed or recorded as a conscious out-of-scope call in `40-tradeoffs.md`, the session cannot go to `status: "concluido"`. **Go straight from the verdict to ONE concrete proposal per FALHA** (fix + effect + cost when relevant) — the user validates/vetoes/accepts as risk PER ITEM; don't ask beforehand whether they want proposals. When applying each one: `30-design.md`, `40-tradeoffs.md`, `diagram.mmd`, the verdict in `45-review.md`, and `scorecard.mjs set-guardrails`.
6. Failures that recur across sessions become items in `learnings.md`.
