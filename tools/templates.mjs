// Session stage templates — module shared between stage.mjs (creation)
// and the pipeline/viewer (stub detection: orange tab while the template hasn't been touched).
// Template CONTENT is English: it becomes actual session artifact text, and
// CLAUDE.md's writing rule keeps session files in English by default. Sessions
// already written in Portuguese stay valid — every lint predicate that reads a
// heading, a label or a fixed vocabulary accepts both languages.
export const TEMPLATES = {
  requirements: [
    '10-requirements.md',
    `# Requirements

## Functional

## Non-functional
_(latency, availability, consistency, durability)_

## Scale
_(users, QPS, data, peaks)_

## Constraints
_(monthly cost target, team, deadline, imposed/banned technologies)_
`,
  ],
  estimates: [
    '20-estimates.md',
    `# Estimates

_(every line shows the math, not just the result)_

## QPS

| | Math | Result |
|---|---|---|

## Storage

## Cache

## Bandwidth
`,
  ],
  domain: [
    '25-domain.md',
    `<!-- lint contract (tools/check.mjs --lint), evaluated after HTML comments are
stripped from the file — this block itself is never read as content:
- Invariants: a table whose header row starts with "| ID |"; IDs follow the
  pattern INV-n; no data cell may be left empty; the "Prevention" column only
  accepts one of prevented in the database / prevented in code / detected
  later / only covered by test, or an explicit not-yet-validated mark. Section
  missing entirely: reported as not checked, never silently passing.
- Lifecycle: a "## Lifecycle" heading containing a mermaid
  stateDiagram-v2 block; every state used as a transition's destination must
  also appear as a transition's source, or terminate at the diagram's final
  state. Enum values declared on a "state" attribute's comment in the
  erDiagram of 35-data-model.md must all exist here too (cross-file
  check, case/accent-insensitive).
- Aggregates: one "### Aggregate: <name>" heading per aggregate; its body must
  mention cardinality (FAIL if it doesn't) and cite the INV-n that justifies
  the boundary, or say the boundary is justified some other way (warning if
  neither is present — concurrency alone is a legitimate justification).
- Contexts x vocabulary: every context listed under "## Contexts" must own
  at least one row of the "| Term | Owning context | Meaning |" table
  under "## Vocabulary"; every owner cited in that table must be one of the
  declared contexts (matched without regard to accents or case).
Tables must be contiguous: the lint stops reading a table at the first line
that isn't part of it. -->
# Domain

## Contexts
_(one bounded context per line — short name and what it owns)_

## Invariants

| ID | Rule | Prevention | In code | In the database | In test |
|---|---|---|---|---|---|

## Lifecycle

\`\`\`mermaid
stateDiagram-v2
\`\`\`

## Aggregates

_(one \`### Aggregate: <name>\` per aggregate — the body mentions "cardinality" and the INV-n that justifies the boundary, or confirms the boundary is "justified" some other way, e.g. concurrency)_

## Vocabulary

| Term | Owning context | Meaning |
|---|---|---|
`,
  ],
  design: [
    '30-design.md',
    `# Design

## The story of a request

_(5-8 numbered steps, end to end — rewrite it whenever the flow changes)_

## API

## Data model

## Deep dives

_(one <details> per topic: cache, failures, consistency...)_
`,
  ],
  'data-model': [
    '35-data-model.md',
    `<!-- lint contract (tools/check.mjs --lint): to declare a state enum on an
erDiagram attribute, name the attribute so it contains "state" and add a
comment right after it with the possible values, lowercase, in the design's
own language, separated by "|" (e.g. a "reserved|confirmed|expired"
comment on a "state" attribute). Every one of those values must also exist
as a state in 25-domain.md's lifecycle diagram (case/accent-insensitive
cross-file check) — this is how a mismatch between the two tabs gets caught
instead of drifting silently. Terms under "## Vocabulary" here are matched
against 25-domain.md's vocabulary the same way. -->
# Data model

## Grain
_(the unit of data that represents the domain's transaction/record — it's what decides the row grain)_

## Entities

\`\`\`mermaid
erDiagram
\`\`\`

## Keys, uniqueness and nulls

## Indexes × queries
_(every query the design depends on ↔ the index that backs it)_

## Data lifecycle
_(retention, purge, cascade)_

## Vocabulary
_(every term here matches a term in the Domain's vocabulary table — same spelling, same meaning)_

| Term | Meaning |
|---|---|
`,
  ],
  tradeoffs: [
    '40-tradeoffs.md',
    `# Trade-offs

<!-- format of each entry:
## N. Decision title
- **Options**: a · b · c
- **Choice**: x
- **Gains**:
- **Loses**:
- **30s defense**: how to articulate the choice out loud, with the nuance that makes the difference.

Fixed sections at the end of the file:
## Deferred decisions  — 1 line each: what would be done + why it can wait.
## Market references (optional) — 1 line per decision: how real systems solve it, with a source.
-->
`,
  ],
  operations: [
    '50-operations.md',
    `# Operations

## Observability
_(metrics per failure mode + alerts)_

## Deploy and rollback

## DR / failure model

## Team to operate it
_(how many engineers, by role, to run it AT the requested scale — and the on-call regime)_

## Total cost and at 10x
`,
  ],
  faq: [
    '90-faq.md',
    `# Anticipated questions

_(the design's FAQ: questions a reader or reviewer would ask, answers of 2-4 lines. An answer that already lives in a trade-off points to it in 1 line.)_
`,
  ],
  poc: [
    '70-poc.md',
    `# POC / MVP

## What this POC proves
_(2-3 risky hypotheses that have to be true for the design to hold — each one becomes steps of the attack order)_

## Folder structure
_(by responsibility, 1 line per folder — no code)_

\`\`\`
root/
└── ...
\`\`\`

## Minimal stack
_(what runs locally — day-1 docker-compose — and what only comes in managed later; a concrete product is welcome here: a POC is an implementation)_

## Attack order
_(3-6 steps; each one ends with **done when:** the observable acceptance criterion)_

## Acceptance metrics
_(table: hypothesis · metric · target · measured with what — the numbers that say "the POC passed")_

## What the POC does NOT prove
_(conscious simplifications — real scale, DR, hardening — and where each one will be proven later)_
`,
  ],
};

// filename -> template content (to detect a stub by exact comparison)
export const TEMPLATE_BY_FILE = Object.fromEntries(Object.values(TEMPLATES));
