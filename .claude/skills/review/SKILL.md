---
name: review
description: Adversarial review of a system design against the guardrails (34 items — failure classes, data & contract, domain & modeling) — marks one of five verdicts (PASS/FALHA/N-A/premise-to-validate/accepted-risk) per item and blocks completion with open failures. Use when the user types /review or before closing out a design.
---

# /review — adversarial review (guardrails)

You are a skeptical staff engineer doing a design review. Goal: find flaws before the design is declared done.

## Two modes

- **Light** (explicit `--leve`; pass 1's closing in the `design` skill runs this procedure inline, without invoking this skill): run `node tools/check.mjs <slug> --lint` and treat the output as ready-made verdicts; then go through the checklist quickly, reporting in detail only the **3-5 failures a sharp reviewer would raise first** — the rest become a one-line verdict. **No gate**: a failure doesn't block sharing; the user fixes the cheap ones (default proposal per item) and sends the expensive ones to "Decisões adiadas" in the trade-offs with a 30s defense. Skip the fine-grained coverage checks (full sheet, "Defesa em 30s", cost with assumptions) — that's the full mode's job. `45-review.md` **doesn't describe itself**: no preamble about the type/scope of the review ("preliminary review", "the full one comes later during polish") — the file goes straight to the verdicts; whatever was left out already lives in "Decisões adiadas" (the CLAUDE.md "no process voice" rule).
- **Full** (default for explicit `/review` and mandatory for `status: "concluido"`): everything below.

1. Resolve the target session (active in the conversation; otherwise ask). **If the session was run in THIS conversation, use the context — re-read only `guardrails.md` and whatever wasn't covered in the conversation**; in a new conversation, read all its files + the root `guardrails.md`.
2. Go through **every item** in the checklist against the real design (34 items: the original failure-class blocks, **Data & Contract** 20-29, **Domain & Modeling** 30-34). Each item gets one of **five verdicts**:
   - **PASS**: the design addresses it — cite where/how.
   - **FALHA**: a concrete gap — describe the specific failure scenario for this design ("if the consumer reprocesses the payment event, it charges twice"), not a generic one.
   - **N/A**: doesn't apply, with a one-line reason.
   - **`[premissa-a-validar]`**: you genuinely can't judge it yet (the design doesn't say enough either way) — never force a PASS/FALHA on an item nobody has actually validated; that would either fake coverage or invent a decision the next reader will take as settled.
   - **RISCO ACEITO**: only when the user, offered a concrete FALHA and its fix, explicitly chooses to carry the risk instead — see step 5's per-item routing.
   Items 30-34 (**Domain & Modeling**) lean on `25-dominio.md` when it exists (its deterministic predicates settle invariants, lifecycle, aggregates, and vocabulary — fold `--lint`'s findings straight in); without that stage, judge them as `[premissa-a-validar]` rather than guessing. **Severity discipline for this block**: a FALHA needs an observed defect, not a preference — "I'd model it differently" is not a finding.
   Be truly adversarial on the rest: look for the scenario that breaks it, not confirmation of what's good.
3. **Mechanical lints belong to the tool, not to you**: run `node tools/check.mjs <slug> --lint`. It's the single deterministic source — `node tools/check.mjs --regras` prints every predicate it checks with its id, requirement, and output (FALHA/aviso/not checked); every line the lint prints starts with the matching `[id]`. Never re-derive that list from memory or from reading the tool's source — read `--regras` instead, since it's the one place guaranteed not to drift from the code. Fold the lint's FALHAs and warnings straight into the verdicts, without re-checking them. Spend your judgment only on what's genuinely semantic and outside the registry: a secondary role with a numbered edge competing with the main flow, niche jargon without a gloss on first use ("overselling", "thundering herd"…) that the jargon predicate wouldn't catch (it only knows internal-mechanics terms, not niche-vocabulary style), and a component named only by the vendor brand without the concept ("DynamoDB" instead of "managed KV store (e.g., DynamoDB)") are warnings; missing `why`/`rejected` on a component born from a real decision is a warning. At the end, update the `guardrails` block via `node tools/scorecard.mjs <slug> set-guardrails` (stdin: `pass`/`falha`/`na`/`premissas`/`riscos` counts + a summary of each open FALHA in `falhas`) — that's what shows up in the Overview.
4. Write `45-review.md` in the session: a summary table (item · verdict · one line) + FALHA details with a suggested direction — sketch the direction rather than solving it outright, unless the user asks you to spell out the fix.
5. **Gate**: as long as there's a FALHA that hasn't been addressed or recorded as RISCO ACEITO, the session cannot go to `status: "concluido"`. **Go straight from the verdict to ONE concrete proposal per FALHA** (fix + effect + cost when relevant) — don't ask beforehand whether the user wants proposals; route each answer per item:
   - **validates** the fix → apply it (`30-design.md`, `40-tradeoffs.md`, `diagram.mmd` as needed) → verdict becomes **PASS**.
   - **vetoes** it outright → verdict **stays FALHA** — a FALHA sent to "Decisões adiadas" in `40-tradeoffs.md` without being accepted as a risk is still a FALHA, not a lighter verdict; adiadas is for scope the user cut, not for unaddressed gaps.
   - **accepts the risk** → verdict becomes **RISCO ACEITO** only once both preconditions exist: an entry in `risks` (via `scorecard.mjs apply`) **and** a decision in `40-tradeoffs.md` (options, choice, what's given up, a "Defesa em 30s"). Missing either one, the item stays FALHA.
   After each routing decision, re-run `scorecard.mjs set-guardrails` with the updated counts.
6. Failures that recur across sessions become items in `learnings.md`.
