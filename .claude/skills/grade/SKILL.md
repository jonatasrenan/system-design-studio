---
name: grade
description: Grades a system design session against the interview rubric, producing per-criterion scores, gaps, and a study plan in 60-avaliacao.md. Use when the user types /grade or asks for a design to be graded.
---

# /grade — grading against the rubric

1. Resolve the target session: the one active in the conversation; otherwise, list `sessions/*/meta.json` and ask which one to grade.
2. **If the session was run in this conversation, use the context** — re-read only `rubric.md` and whatever wasn't covered in the conversation. In a new conversation, read all the session's files and the root `rubric.md`.
3. Grade each of the 8 criteria 1-4. For each criterion:
   - **Evidência**: concrete quotes/facts from the session that support the score.
   - **Lacunas**: what an interviewer would expect and didn't show up (be specific: "didn't discuss idempotency in the consumer", not "lacked reliability").
4. Also check the rubric's good practices (concept before tool, explicit trade-offs, operations, total cost) and the diagram: does `diagram.mmd` reflect the final design? Is it legible (grouping, labels)?
5. Update the rubric block via `node tools/scorecard.mjs <slug> set-rubric '<json>'` (`overall` + `scores` per criterion) — feeds the Overview tab.
5b. **Feed `argumentario.md`** (root): decision patterns exercised in this session that repeat across designs (e.g., 301 vs 302, SQL vs KV, queue vs stream) become/update entries with the short defense — pre-interview review material. Don't duplicate: update the existing entry citing the new session.
6. Write `60-avaliacao.md` — **self-contained text, readable by third parties via the shared link**: no commands/skills/internal mechanics (the CLAUDE.md rule); next steps in natural language:
   - Table: criterion · score · one-line summary.
   - A section per criterion with evidence and gaps.
   - **Study plan**: 3-5 prioritized items (topic, why it matters, what to study/practice).
   - Overall score and an honest verdict on interview readiness.
7. **Update `learnings.md`** (root): every relevant gap becomes an `aberto` item (or reinforces an existing one — don't duplicate); `aberto` items from previous sessions that were demonstrated solidly in this session are promoted to `dominado`, citing this session as evidence.
8. If applicable, change `status` to `"concluido"` in `meta.json` (`updated` is already kept by the tools) and summarize the verdict in the conversation. Inflated scores defeat the purpose of the harness — be as rigorous as a real senior interviewer.
