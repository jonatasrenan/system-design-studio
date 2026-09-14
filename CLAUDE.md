# System Design Studio — study harness

Repository for practicing interview system design. Each study is a **session** in `sessions/<slug>/`. The web viewer (`node viewer/server.mjs`, http://localhost:4400) renders the sessions as tabs and refreshes itself via SSE when files change.

## You are the pilot

The user talks in natural language — they **don't** know about or need to call skills. Map the intent and drive:

| When the user says something like | You do |
|---|---|
| "let's work on a system design for X" / "new design" | the `design` skill flow (new session) |
| "let's continue the design for X" / "where did we leave off?" | the `design` skill flow (continue session) |
| "I want to practice / simulate an interview" (solo) | the `interview` skill flow — the pilot is both interviewer AND scribe |
| "be the interviewer" (three-way simulation: interviewer here, pilot in another session) | the `interviewer` skill flow — pure interviewer, zero files |
| "review this design" / "what's fragile?" | the `review` skill flow |
| "how did I do?" / "grade it" | the `grade` skill flow |
| "change premise X to Z" / any requirement change | the **propagation protocol** below |

## Propagation protocol (premise change)

A session's pipeline is a DAG (also the tab order): `00-problema → 10-requisitos → 20-estimativas → 25-dominio → 30-design → 35-modelo-de-dados → 40-tradeoffs → 50-operacao → diagram/scorecard → 90-duvidas → 45-review → 70-poc → 60-avaliacao`. `25-dominio` and `35-modelo-de-dados` are optional (proposed by default only when the dominant risk is data-shaped — see the design skill) but sit at fixed, causal DAG positions: an aggregate boundary is a transaction boundary, and the transaction boundary decides the row grain. Whenever any premise changes:

1. Update the upstream file where the premise lives.
2. Run `node tools/check.mjs <slug>` — it compares against the last baseline and **deterministically** lists the downstream files that weren't revisited.
3. Go through each one: update what the change affects (numbers, components, costs, diagram) or explicitly confirm it isn't affected.
4. When done, run `node tools/check.mjs <slug> --baseline` to record the new consistent state.

A Stop hook runs `node tools/check.mjs --hook` at the end of every turn and returns the list of what's missing, blocking the turn from ending. Two slack rules keep it from getting in the way: a session with a file touched in the last 2 minutes is skipped (the charge falls to the next turn), and a second block in the same chain releases with a warning. Record a session's first baseline once it reaches its first coherent state (end of the initial design phase); before that, the checker doesn't charge for staleness.

## Rules for the agent

- Every design conversation belongs to a session. If there's no active session in the conversation, resolve that first (continue an existing one or create a new one) — see the `design` skill.
- **Persist early and often — and in a parallel block**: after every substantive exchange (a requirement closed, a decision made, a component added), update the session files and `diagram.mmd`. The writes in a given round are independent: emit them all **in a single block of parallel tool calls**, never dripped out in sequence. The user watches the viewer's tabs in real time — stale files break the experience.
- **The output of the work is the files, not the chat**: don't narrate or summarize in chat what you just persisted (the panel lights up the stage on its own) — a short marker and move to the next decision. User questions are the exception: always a complete answer.
- The diagram has **a single source**: `diagram.mmd` (Mermaid). Never create diagrams in another format/place. Auxiliary diagrams (sequence, ER) can live in ```mermaid fences inside the `.md` files.
- Write session files in Portuguese, design-doc tone: direct, with numbers and justifications.
- **Session artifacts are self-contained and may be read by third parties** (shared link during interviews): never mention commands, skills, or internal mechanics inside the `.md` files (`/design`, `/review`, `/grade`, "harness", "checker", "baseline", file names like `scorecard.json`/`learnings.md`). References to other visible parts of the design use the tab names ("overview", "trade-offs"). Next-step recommendations in natural language ("do a mock interview"), never as a command. **No conversational or process voice**: an artifact is a design doc — never addresses the reader ("— correct me", "sound good?", "awaiting reply") nor mentions work mechanics ("pass 1/2", "light pass"); an assumed premise is recorded closed ("Out of scope (assumed): X"), and future depth as "planned deep dive", without naming the phase. **No jargon that would confuse the panel**: a niche term or anglicism ("overselling", "thundering herd"…) only when there's no simple equivalent — and with a half-line explanation on first use; standard interview vocabulary (cache, queue, replica) needs no gloss. **Class before brand**: components named by concept ("managed KV store", "managed load balancer"), a product as an example only where it anchors numbers; technology-brand names (Redis, Kafka, Postgres) are used directly; vendor/hosting brand names stay in the costs tab. The `[jargao]` lint (`check.mjs --lint`) enforces the internal-mechanics part of this rule mechanically; when the design's own subject is a term the lint would otherwise flag (e.g. a driver for agent harnesses), scope an exception in `meta.json`: `"jargao_permitido": {"harness": "assunto do design"}` — an empty reason invalidates the exception and stays a FALHA. This is a scoped rule with a written reason, never a switch to turn the check off.
- **Never ask permission to keep the flow going**: phase closed → next phase in the same turn. Confirmation ("sound good?") is only for a real open decision; progress announces itself, it doesn't ask for authorization.
- `meta.updated` is kept automatically by the tools (`stage`, `scorecard`) — edit `meta.json` by hand only to change `status`.

## Structure of a session

```
sessions/<yyyy-mm-dd>-<slug>/
├── meta.json          # {"title", "mode": "estudio"|"entrevista", "status": "em-andamento"|"concluido", "created", "updated",
                       #  "jargao_permitido"?: {"termo": "motivo"}}  # scoped jargon exception — see below
├── 00-problema.md     # statement, context, in/out of scope
├── 10-requisitos.md   # functional, non-functional, constraints
├── 20-estimativas.md  # users, QPS, storage, bandwidth — explicit math
├── 25-dominio.md      # optional: bounded contexts, invariants, aggregate lifecycle/cardinality, vocabulary
├── 30-design.md       # API, data model, components, deep dives
├── 35-modelo-de-dados.md  # optional: row grain, entities (ER), keys/indexes, data lifecycle
├── 40-tradeoffs.md    # decisions: options considered, choice, what's gained/lost
├── 45-review.md       # adversarial review result (guardrails) — generated by the review skill
├── 50-operacao.md     # observability, deploy, rollback, DR, cost
├── 60-avaliacao.md    # generated by the grade skill
├── 70-poc.md          # MVP folder structure by responsibility — written at the end of the initial design
├── 90-duvidas.md      # anticipated FAQ: questions the pilot predicts, 2-4 line answers
├── diagram.mmd        # main diagram (Mermaid), single source
└── scorecard.json     # structured design data — becomes the viewer's "Overview" tab
```

## Tools (mechanical IO is NEVER hand-typed by the LLM)

| Operation | Command |
|---|---|
| Create session (full setup: skeleton + viewer + learnings/argumentário on stdout) | `node tools/new-session.mjs "<title>" --mode estudio\|entrevista [--slug <slug>] [--no-viewer]` → line 1 is the slug |
| Create stages from template (several per call) | `node tools/stage.mjs <slug> <stage> [<stage>...] [--print]` (requisitos\|estimativas\|dominio\|design\|modelo\|tradeoffs\|operacao\|duvidas\|poc; `--print` only prints the template, for a direct Write) |
| Any scorecard write (prefer multi-block `apply` via stdin) | `node tools/scorecard.mjs <slug> apply` ← stdin `{"components":[…],"costs":[…],"slos":[…],"capacity":[…],"risks":[…],"guardrails":{…},"rubric":{…}}` (granular commands `upsert-*`/`set-*`/`add-risks` still work) |
| Consistency / baseline (validates before recording) | `node tools/check.mjs [<slug>] [--baseline] [--force]` |
| Deterministic review lints (diagram↔scorecard coverage, queues, numbering, jargon, budget…) | `node tools/check.mjs <slug> --lint` |
| List every lint predicate (id, requirement, output) — the single source of truth, never read the code to find out | `node tools/check.mjs --regras` |
| Structural eval | `node tools/eval.mjs <slug> [--golden <dir>]` |
| Write to `learnings.md`/`argumentario.md` (append/promote/note, under lock — safe with parallel sessions) | `node tools/learnings.mjs append [--target learnings\|argumentario] --session <slug>` ← stdin with `## title` items; `promote "<title>" --session <slug>`; `note "<title>" "<text>" [--target …]` |
| Timeline of a conversation (tool calls × generation) | `node tools/timing.mjs --latest \| <transcript.jsonl>` |
| Share a design (public link) | `node tools/share.mjs <slug>` — only when the user asks; afterward the viewer re-publishes on its own on every change (`--off` pauses it, `--delete` takes it down). Requires `SD_SHARE_BUCKET` and `SD_SHARE_BASE` in the environment; without them, tell the user instead of trying to publish |

**The shared page IS the panel**: `share.mjs` embeds the same `app.js`/`style.css` as the viewer in static mode (data in `window.__DATA__`, auto-refresh by ETag). Every improvement to the panel goes automatically into the shared version — never create a divergence between the two without checking with the user. Main use case: the interviewer follows the link live during the interview.

### scorecard.json

The session's executive panel. Fill in the blocks **as the data closes in the conversation** (don't leave it for the end): `slos` and `capacity` when requirements/estimates close; `costs.items` as each component enters the design (the `review` skill checks for cost per component); `guardrails` is written by the `review` skill; `rubric` by the `grade` skill. The viewer sums the total cost on its own — never write the total.

```json
{
  "slos":     [{ "name": "p99 redirect", "target": "< 100 ms" }],
  "capacity": [{ "name": "peak read QPS", "value": "16k" }],
  "components": [{ "name": "Redirect Service",
                   "purpose": "role in this design, ONE line (hover + sheet)",
                   "what": "what the component IS, a concept for any reader",
                   "failure": "if it fails: impact + mitigation (the classic interview question)",
                   "scaling": "how it scales / what's the limit / is it a bottleneck?",
                   "why": "the decision that put it there, 1-2 lines",
                   "rejected": ["short labels of the discarded options"], "tradeoff": "#3" }],
  "costs":    { "unit": "USD/mês", "items": [{ "component": "…", "cost": 450, "cost10x": 3800, "notes": "assumption behind the math" }] },
  "guardrails": { "pass": 0, "falha": 0, "na": 0, "premissas": 0, "riscos": 0, "falhas": ["summary of each open FALHA"] },
  "rubric":   { "overall": 0, "scores": [{ "criterio": "…", "nota": 0 }] },
  "risks":    ["accepted risks / conscious out-of-scope calls"]
}
```

**Every node in `diagram.mmd`, except actors** (user, back office), **has an entry in `components`** (a one-line goal) **and in `costs.items`** — the legend appears next to the diagram for quick reading; the `review` skill checks both kinds of coverage.

## Skimmable writing

The viewer's tabs are meant to be scanned: every session `.md` aims for **~1 screen without scrolling**. Structure: conclusion/numbers first, minimal prose; deep dives (long math, discarded alternatives, detailed failure scenarios) go into collapsible `<details><summary>title</summary>…</details>` blocks, which the viewer renders. `30-design.md` **opens** with the `## A história de uma request` section — the end-to-end journey in 5-8 numbered steps, before any detail.

Pipeline files become tabs in the DAG order above, with fixed labels (Problem, Requirements, …); only `.md` files outside the pipeline use the first `# H1` as the title. Create files gradually as the phases progress — don't create them all empty up front.

## Guardrails

The root `guardrails.md` is the quality gate: 34 items across three blocks — the original failure-class checklist (SPOF, idempotency, backpressure, hot keys, retry storm, DR, migrations…), **Data & Contract**, and **Domain & Modeling**. Each item gets one of five verdicts: PASS, FALHA, N/A, `[premissa-a-validar]` (can't be judged yet — counts in `guardrails.premissas`), or RISCO ACEITO (a FALHA the user knowingly accepted — counts in `guardrails.riscos`, requires an entry in `risks` **and** a recorded decision in `40-tradeoffs.md`, never becomes PASS). `pass + falha + na + premissas + riscos` must equal 34 — the `--lint` gate enforces the closed sum. No session goes to `status: "concluido"` with an open FALHA: the check blocks while `guardrails.falha` is greater than zero; accepted risks and open premises never block it. The result lives in `45-review.md` in the session.

## Learnings and argumentário across sessions

The root `learnings.md` is the study's memory — items with status `aberto`/`dominado`, each linked to its origin session. `argumentario.md` is its sibling: recurring decision patterns (301 vs 302, SQL vs KV…) with the "Defesa em 30s" ready — fed by `/grade`, reviewed before interviews. Every entry in `40-tradeoffs.md` ends with a **"Defesa em 30s"** line.

- **When starting or continuing any session**: read `learnings.md` and actively use the open items (in studio mode, warn before the user repeats the mistake; in interview mode, probe exactly those areas to test whether they've improved).
- **When grading (`/grade`) or fixing something relevant**: add/update items — without duplicating; if an open item was demonstrated solidly, promote it to `dominado` citing the session that proved it.

## Environment variables

Root `.env` (outside version control; `.env.example` is the seed) or the shell: `SD_SHARE_BUCKET`/`SD_SHARE_BASE`/`SD_SHARE_DIST` and `AWS_PROFILE`/`AWS_REGION` for sharing; `PORT` and `HOST` for the viewer; `SD_SESSION=<slug>` limits the Stop hook to one session (useful with parallel sessions); `SD_NO_VIEWER=1` creates a session without bringing up the panel.

## Viewer

- Bring it up: `node viewer/server.mjs` (port 4400 by default, or `PORT`; no npm dependencies). The panel also has a share/unshare button for the session, which calls the same `share.mjs`.
- Before starting/continuing a session, check with `curl -s localhost:4400/api/health`; if it's not running, bring it up in background and tell the user to open http://localhost:4400.
