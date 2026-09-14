---
name: harness-eval
description: Evaluates whether the harness produced a correct process/result for a session — a deterministic layer (tools/eval.mjs) + semantic judgment (LLM-as-judge), with an optional comparison against a golden session. Use after blind tests or changes to the harness.
---

# /harness-eval — harness evaluation (not the design, and not the person)

Object of evaluation: **the harness's process**, not the quality of the design itself (that's `/review`'s job). Preferably run it in a different Claude session than the one that produced the design (independent judge).

Arguments: `<slug|session path>` and optionally `--golden <dir>` (the user provides the golden's path; don't assume one).

## Layer 1 — deterministic

Run `node tools/eval.mjs <target> [--golden <dir>]` and fold the result in. Any ✗ is an objective harness failure — go straight to the root cause (did the skill not instruct it? did the hook not fire? did the agent ignore a convention?).

**Process cost**: also run `node tools/timing.mjs --latest` (or with the transcript path of the evaluated session) — outputs the timeline of tool calls, durations, and generation gaps. Use it to point out harness friction (unnecessary Reads, drip-fed calls, skill round-trips) separately from the legitimate cost of content generation.

## Layer 2 — semantic judge

What scripts don't catch. Read all the session's artifacts (and the golden's, if any) and judge each dimension 1-4 + evidence:

1. **Coherence across stages**: do the numbers match between requirements → estimates → scorecard → design? (e.g., declared QPS vs. cache sizing; cost mentioned in the text vs. costs in the scorecard)
2. **Diagram ↔ design fidelity**: is every component mentioned in the design in the diagram and vice versa? Does the legend describe what the design says the component does?
3. **Semantic propagation**: if there was a premise change in the session, did it actually reach the downstream files (numbers recalculated, not just files "touched" to fool the hash checker)?
4. **Process depth**: were requirements gathered before the solution? Do trade-offs have real alternatives and explicit losses, or are they rhetorical? Was the review adversarial or a rubber stamp?
5. **Skimmability**: does each stage read in ~1 screen? Does the request story let you understand the system without reading the rest?
6. **(with golden)** Relative coverage: what does the golden have that the candidate doesn't — and is it a *harness* miss (didn't drive it) or a legitimate design variation?

Important: designs that differ from the golden can be equally valid — judge **process and completeness**, not similarity of solution.

## Report

Write the verdict to a file `eval-report-<yyyy-mm-dd>.md` **inside the directory the user points to** (in a blind test, outside the repo, next to the golden): the layer 1 result, a table of the 6 dimensions with scores and evidence, a list of harness regressions/gaps with the suggested fix (which skill/guardrail/tool to touch), and a final verdict: **harness OK / harness regressed / inconclusive**. Summarize the verdict in the conversation.
