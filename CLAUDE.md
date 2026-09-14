# System Design Studio — a harness for taking a design to a consistent, reviewable state

Repository for building out system designs to production rigor, one session at a time. Each design is a **session** in `sessions/<slug>/`: requirements, estimates, a diagram, trade-offs, an adversarial review against a fixed checklist — files you can reread, diff, and hand to someone else. The web viewer (`node viewer/server.mjs`, http://localhost:4400) renders the sessions as tabs and refreshes itself via SSE when files change.

## You are the pilot

The user talks in natural language — they **don't** know about or need to call skills. Map the intent and drive:

| When the user says something like | You do |
|---|---|
| "let's work on a system design for X" / "new design" | the `design` skill flow (new session) |
| "let's continue the design for X" / "where did we leave off?" | the `design` skill flow (continue session) |
| "review this design" / "what's fragile?" / "evaluate this" | the `review` skill flow — it's the design that gets evaluated, not the person |
| "be the mesa" / "I want to rehearse the defense" | the `mesa` skill flow — a live skeptical reviewer, no files touched, no score |
| "change premise X to Z" / any requirement change | the **propagation protocol** below |

"How did I do?" has no mapping to a skill: whoever asks that is at the end of a `mesa` rehearsal, and the answer is the closing `mesa` already gives — in chat, never written to a file. A design doesn't get a 1-4 score here; it gets a verdict per guardrails item, which is a sharper and more actionable thing.

## Propagation protocol (premise change)

A session's pipeline is a DAG (also the tab order): `00-problem → 10-requirements → 20-estimates → 25-domain → 30-design → 35-data-model → 40-tradeoffs → 50-operations → diagram/scorecard → 90-faq → 45-review → 70-poc`. `25-domain` and `35-data-model` are optional (proposed by default only when the dominant risk is data-shaped — see the design skill) but sit at fixed, causal DAG positions: an aggregate boundary is a transaction boundary, and the transaction boundary decides the row grain. Whenever any premise changes:

**The order is what makes this protocol useful — do not reorder it.** Running the checker before editing anything tells you nothing (nothing changed yet, so it reports "consistent"); editing every downstream file from memory and only then rewriting the baseline is exactly how a stale number survives — the checker never gets a chance to point at what you skipped.

1. Edit **only** the upstream file where the premise lives — nothing else yet.
2. Run `node tools/check.mjs <slug>` — it compares against the last baseline and **deterministically** lists the downstream files that weren't revisited. This list is the roadmap for step 3, not a formality to glance at.
3. Go through **every** file on that list: recompute the number, swap the component, adjust cost and diagram (`scorecard.mjs remove-*` for whatever left the design), or explicitly confirm in writing that this specific file isn't affected.
4. Only once every file on the list has been handled, run `node tools/check.mjs <slug> --baseline`. Use `--note "<text>"` when a file's answer to step 3 was "unaffected" — it records that confirmation in the session state instead of leaving it only in the conversation; `check.mjs <slug>` (no flags) prints the latest note back. The last 20 notes are kept.

A Stop hook runs `node tools/check.mjs --hook` at the end of every turn and returns the list of what's missing, blocking the turn from ending. Two slack rules keep it from getting in the way: a session with a file touched in the last 2 minutes is skipped (the charge falls to the next turn), and a second block in the same chain releases with a warning. Record a session's first baseline once it reaches its first coherent state (end of the initial design phase); before that, the checker doesn't charge for staleness.

## Rules for the agent

- Every design conversation belongs to a session. If there's no active session in the conversation, resolve that first (continue an existing one or create a new one) — see the `design` skill.
- **Persist early and often — and in a parallel block**: after every substantive exchange (a requirement closed, a decision made, a component added), update the session files and `diagram.mmd`. The writes in a given round are independent: emit them all **in a single block of parallel tool calls**, never dripped out in sequence. The user watches the viewer's tabs in real time — stale files break the experience.
- **The output of the work is the files, not the chat**: don't narrate or summarize in chat what you just persisted (the panel lights up the stage on its own) — a short marker and move to the next decision. User questions are the exception: always a complete answer.
- The diagram has **a single source**: `diagram.mmd` (Mermaid). Never create diagrams in another format/place. Auxiliary diagrams (sequence, ER) can live in ```mermaid fences inside the `.md` files.
- **Write session files in English by default**, design-doc tone: direct, with numbers and justifications. A session already written in another language stays in it (the user can ask for one in their own language at any point) — no lint judges the language of the content; every predicate that reads a heading, a label or a fixed vocabulary accepts both English and Portuguese.
- **Session artifacts are self-contained and may be read by third parties** (shared link, a reviewer, a mesa rehearsal): never mention commands, skills, or internal mechanics inside the `.md` files (`/design`, `/review`, "harness", "checker", "baseline", file names like `scorecard.json`/`learnings.md`). References to other visible parts of the design use the tab names ("overview", "trade-offs"). Next-step recommendations in natural language ("rehearse the defense"), never as a command. **No conversational or process voice**: an artifact is a design doc — never addresses the reader ("— correct me", "sound good?", "awaiting reply") nor mentions work mechanics ("pass 1/2", "light pass"); an assumed premise is recorded closed ("Out of scope (assumed): X"), and future depth as "planned deep dive", without naming the phase. **No jargon that would confuse the panel**: a niche term or anglicism ("overselling", "thundering herd"…) only when there's no simple equivalent — and with a half-line explanation on first use; standard system-design vocabulary (cache, queue, replica) needs no gloss. **Class before brand**: components named by concept ("managed KV store", "managed load balancer"), a product as an example only where it anchors numbers; technology-brand names (Redis, Kafka, Postgres) are used directly; vendor/hosting brand names stay in the costs tab. The `[jargon]` lint (`check.mjs --lint`) enforces the internal-mechanics part of this rule mechanically; when the design's own subject is a term the lint would otherwise flag (e.g. a driver for agent harnesses), scope an exception in `meta.json`: `"allowed_jargon": {"harness": "the design's own subject"}` — an empty reason invalidates the exception and stays a FAIL. This is a scoped rule with a written reason, never a switch to turn the check off.
- **Never ask permission to keep the flow going**: phase closed → next phase in the same turn. Confirmation ("sound good?") is only for a real open decision; progress announces itself, it doesn't ask for authorization.
- `meta.updated` is kept automatically by the tools (`stage`, `scorecard`) — edit `meta.json` by hand only to change `status`.

## Structure of a session

```
sessions/<yyyy-mm-dd>-<slug>/
├── meta.json          # {"title", "status": "in-progress"|"done", "created", "updated",
                       #  "allowed_jargon"?: {"term": "reason"}}  # scoped jargon exception — see below
├── 00-problem.md     # statement, context, in/out of scope
├── 10-requirements.md   # functional, non-functional, constraints
├── 20-estimates.md  # users, QPS, storage, bandwidth — explicit math
├── 25-domain.md      # optional: bounded contexts, invariants, aggregate lifecycle/cardinality, vocabulary
├── 30-design.md       # API, data model, components, deep dives
├── 35-data-model.md  # optional: row grain, entities (ER), keys/indexes, data lifecycle
├── 40-tradeoffs.md    # decisions: options considered, choice, what's gained/lost
├── 45-review.md       # adversarial review result (guardrails) — generated by the review skill
├── 50-operations.md     # observability, deploy, rollback, DR, cost
├── 70-poc.md          # MVP folder structure by responsibility — written at the end of the initial design
├── 90-faq.md      # anticipated FAQ: questions the pilot predicts, 2-4 line answers
├── diagram.mmd        # main diagram (Mermaid), single source
└── scorecard.json     # structured design data — becomes the viewer's "Overview" tab
```

## Tools (mechanical IO is NEVER hand-typed by the LLM)

| Operation | Command |
|---|---|
| Create session (full setup: skeleton + viewer + learnings/patterns on stdout) | `node tools/new-session.mjs "<title>" [--slug <slug>] [--no-viewer]` → line 1 is the slug |
| Create stages from template (several per call) | `node tools/stage.mjs <slug> <stage> [<stage>...] [--print]` (requirements\|estimates\|domain\|design\|data-model\|tradeoffs\|operations\|faq\|poc; `--print` only prints the template, for a direct Write) |
| Any scorecard write (prefer multi-block `apply` via stdin) | `node tools/scorecard.mjs <slug> apply` ← stdin `{"components":[…],"costs":[…],"slos":[…],"capacity":[…],"risks":[…],"guardrails":{…}}` (granular commands `upsert-*`/`set-*`/`add-risks` still work; `remove-components`/`remove-costs`/`remove-slos`/`remove-capacity`/`remove-risks` drop a superseded entry — a revised number replaces the old one, it never sits next to it) |
| Consistency / baseline (validates before recording; prints the latest `--note` when called without flags) | `node tools/check.mjs [<slug>] [--baseline] [--force] [--note "<text>"]` |
| Deterministic review lints (diagram↔scorecard coverage, queues, numbering, jargon, budget…) | `node tools/check.mjs <slug> --lint` |
| List every lint predicate (id, requirement, output) — the single source of truth, never read the code to find out | `node tools/check.mjs --rules` |
| Structural eval | `node tools/eval.mjs <slug> [--golden <dir>]` |
| Write to `learnings.md`/`patterns.md` (append/promote/note, validated, under lock — safe with parallel sessions) | `node tools/learnings.mjs append [--target learnings\|patterns] --session <slug>` ← stdin with `## title` items (an item missing a required field is refused, with the format in the message); `promote "<title>" --session <slug>`; `note "<title>" "<text>" [--target …]` |
| Timeline of a conversation (tool calls × generation) | `node tools/timing.mjs --latest \| <transcript.jsonl>` |
| Share a design (public link) | `node tools/share.mjs <slug>` — only when the user asks; afterward the viewer re-publishes on its own on every change (`--off` pauses it, `--delete` takes it down). Requires `SD_SHARE_BUCKET` and `SD_SHARE_BASE` in the environment; without them, tell the user instead of trying to publish |

**The shared page IS the panel**: `share.mjs` embeds the same `app.js`/`style.css` as the viewer in static mode (data in `window.__DATA__`, auto-refresh by ETag). Every improvement to the panel goes automatically into the shared version — never create a divergence between the two without checking with the user. Main use case: a reviewer (or a `mesa` rehearsal) follows the link live.

### scorecard.json

The session's executive panel. Fill in the blocks **as the data closes in the conversation** (don't leave it for the end): `slos` and `capacity` when requirements/estimates close; `costs.items` as each component enters the design (the `review` skill checks for cost per component); `guardrails` is written by the `review` skill. The viewer sums the total cost on its own — never write the total.

```json
{
  "slos":     [{ "name": "p99 redirect", "target": "< 100 ms" }],
  "capacity": [{ "name": "peak read QPS", "value": "16k" }],
  "components": [{ "name": "Redirect Service",
                   "purpose": "role in this design, ONE line (hover + sheet)",
                   "what": "what the component IS, a concept for any reader",
                   "failure": "if it fails: impact + mitigation (the classic design-review question)",
                   "scaling": "how it scales / what's the limit / is it a bottleneck?",
                   "why": "the decision that put it there, 1-2 lines",
                   "rejected": ["short labels of the discarded options"], "tradeoff": "#3" }],
  "costs":    { "unit": "USD/month", "items": [{ "component": "…", "cost": 450, "cost10x": 3800, "notes": "assumption behind the math" }] },
  "guardrails": { "pass": 0, "fail": 0, "na": 0, "premises": 0, "accepted_risks": 0, "failures": ["summary of each open FAIL"] },
  "risks":    ["accepted risks / conscious out-of-scope calls"]
}
```

**Every node in `diagram.mmd`, except actors** (user, back office), **has an entry in `components`** (a one-line goal) **and in `costs.items`** — the legend appears next to the diagram for quick reading; the `review` skill checks both kinds of coverage.

## Skimmable writing

The viewer's tabs are meant to be scanned: every session `.md` aims for **~1 screen without scrolling**. Structure: conclusion/numbers first, minimal prose; deep dives (long math, discarded alternatives, detailed failure scenarios) go into collapsible `<details><summary>title</summary>…</details>` blocks, which the viewer renders. `30-design.md` **opens** with the `## The story of a request` section — the end-to-end journey in 5-8 numbered steps, before any detail.

Pipeline files become tabs in the DAG order above, with fixed labels (Problem, Requirements, …); only `.md` files outside the pipeline use the first `# H1` as the title. Create files gradually as the phases progress — don't create them all empty up front.

## Guardrails

The root `guardrails.md` is the quality gate: 34 items across three blocks — the original failure-class checklist (SPOF, idempotency, backpressure, hot keys, retry storm, DR, migrations…), **Data & Contract**, and **Domain & Modeling**. Each item gets one of five verdicts: PASS, FAIL, N/A, `[premise-to-validate]` (can't be judged yet — counts in `guardrails.premises`), or ACCEPTED RISK (a FAIL the user knowingly accepted — counts in `guardrails.accepted_risks`, requires an entry in `risks` **and** a recorded decision in `40-tradeoffs.md`, never becomes PASS). `pass + fail + na + premises + accepted_risks` must equal 34 — the `--lint` gate enforces the closed sum. No session goes to `status: "done"` with an open FAIL: the check blocks while `guardrails.fail` is greater than zero; accepted risks and open premises never block it. The result lives in `45-review.md` in the session.

## Learnings and patterns across sessions

The root `learnings.md` is the study's memory of **recurring mistakes** — each item has a fixed, validated format (`node tools/learnings.mjs` refuses anything else, citing the format): `**Status**: open|mastered`, `**Origin**: sessions/<slug> (date)`, `**Learning**` (1-3 sentences), `**How to apply**` (a practical trigger for next time). `patterns.md` is its sibling for **decisions already resolved**: recurring patterns (301 vs 302, SQL vs KV…) with `**Choice**`, `**When it changes**`, a ready `**30s defense**`, and `**Seen in**`. Every entry in `40-tradeoffs.md` also ends with a **"30s defense"** line.

- **When starting or continuing any session**: `new-session.mjs`'s stdout (or a manual read of `learnings.md`/`patterns.md` when continuing) delivers every open item, bracketed by two count lines so truncation is visible — actively use them, warning before the user repeats the mistake. An item missing its `**Status**` line is treated as open by default, never silently dropped.
- **The moment something is corrected or a pattern repeats**, write it via `tools/learnings.mjs append --session <slug>` (or `--target patterns`) in the same turn — never by editing the file as text (parallel sessions would corrupt a concurrent write; the tool writes under a lock). If an open item was demonstrated solidly, `promote "<title>" --session <slug>`.

## Environment variables

Root `.env` (outside version control; `.env.example` is the seed) or the shell: `SD_SHARE_BUCKET`/`SD_SHARE_BASE`/`SD_SHARE_DIST` and `AWS_PROFILE`/`AWS_REGION` for sharing; `PORT` and `HOST` for the viewer; `SD_SESSION=<slug>` limits the Stop hook to one session (useful with parallel sessions); `SD_NO_VIEWER=1` creates a session without bringing up the panel.

## Viewer

- Bring it up: `node viewer/server.mjs` (port 4400 by default, or `PORT`; no npm dependencies). The panel also has a share/unshare button for the session, which calls the same `share.mjs`.
- Before starting/continuing a session, check with `curl -s localhost:4400/api/health`; if it's not running, bring it up in background and tell the user to open http://localhost:4400.
