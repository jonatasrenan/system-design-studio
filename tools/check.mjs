// Consistency checker for sessions.
//
// Two kinds of checks, both deterministic:
//  - structural: valid meta.json/scorecard.json; a "done" session requires
//    a review to be present and guardrails with no FAIL.
//  - staleness: the pipeline is a linear DAG — the canonical order is ORDER, in
//    pipeline.mjs (also restated in prose in CLAUDE.md; the [dag-prose] predicate
//    below keeps that prose from drifting out of sync with ORDER — read ORDER
//    itself for the order, never copy it a third time).
//    A per-session `.state.json` stores the hashes of the last consistent state
//    (baseline). If an upstream file changed since the baseline and some downstream
//    file didn't, the downstream file is potentially stale — the agent needs to
//    revisit it (update it or confirm nothing changes) and run --baseline.
//
// Usage:
//   node tools/check.mjs                  # checks every session + the repo-wide DAG-prose rule
//   node tools/check.mjs <slug>           # checks one session
//   node tools/check.mjs <slug> --baseline  # validates structure and marks the state as consistent
//   node tools/check.mjs <slug> --lint    # deterministic review lints (diagram, queues, jargon...)
//   node tools/check.mjs --rules          # lists every lint predicate: id, what it requires, what it reports
//   node tools/check.mjs --hook           # Stop-hook mode: exit 2 blocks the turn
//
// `--rules` is the single source of truth for what `--lint` checks — every message
// the lint prints starts with the matching [id]; read `--rules` instead of the
// source when you need to know what's covered.
//
// Per-agent scoping (parallel execution): with the SD_SESSION=<slug> environment
// variable, --hook mode (and the no-slug call) checks ONLY that session — one
// agent's Stop hook is never blocked by another agent's in-progress session.
// An explicit slug on the command line still takes priority. In --hook mode,
// SD_SESSION pointing to a session that doesn't exist yet is ignored (exit 0).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER, hashFile, stageStatus, parseDiagram, JARGON, writeAtomic, stripHtmlComments, RETIRED_STAGES } from './pipeline.mjs';
import { TEMPLATE_BY_FILE } from './templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS_DIR = path.join(ROOT, 'sessions');

// accepts a sessions/ slug or a directory path (e.g. an eval golden)
const resolveDir = (slug) => (slug.includes('/') ? path.resolve(slug) : path.join(SESSIONS_DIR, slug));

function checkSession(slug) {
  const dir = resolveDir(slug);
  const problems = [];
  const file = (n) => path.join(dir, n);
  if (!fs.existsSync(dir)) return [`session not found: ${slug} (check the slug under sessions/)`];

  // --- structural ---
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(file('meta.json'), 'utf8'));
    for (const k of ['title', 'status'])
      if (!meta[k]) problems.push(`meta.json missing field "${k}"`);
  } catch (e) {
    problems.push(`meta.json missing or invalid: ${e.message}`);
  }

  let scorecard = null;
  if (fs.existsSync(file('scorecard.json'))) {
    try {
      scorecard = JSON.parse(fs.readFileSync(file('scorecard.json'), 'utf8'));
      for (const it of scorecard?.costs?.items ?? []) {
        if (typeof it.cost !== 'number') problems.push(`scorecard: non-numeric cost in "${it.component}"`);
        if (it.cost10x !== undefined && typeof it.cost10x !== 'number')
          problems.push(`scorecard: non-numeric cost10x in "${it.component}"`);
      }
    } catch (e) {
      problems.push(`invalid scorecard.json: ${e.message}`);
    }
  }

  if (meta?.status === 'done') {
    if (!fs.existsSync(file('45-review.md')))
      problems.push('status "done" without 45-review.md (run the guardrails review)');
    const g = scorecard?.guardrails;
    if (!g) problems.push('status "done" without a guardrails block in the scorecard');
    else if (g.fail > 0) problems.push(`status "done" with ${g.fail} open FAIL(s) in the guardrails`);
  }

  // --- baseline ritual: a standing design without a baseline = untracked consistency ---
  const { baseline: hasBaseline, stages } = stageStatus(dir);
  if (!hasBaseline && fs.existsSync(file('30-design.md')) && fs.existsSync(file('40-tradeoffs.md'))) {
    problems.push(
      `standing design without a consistency baseline — run: node tools/check.mjs ${slug} --baseline ` +
        `(without it, premise changes aren't tracked)`
    );
  }
  if (hasBaseline) {
    const changed = stages.filter((s) => s.status === 'editado').map((s) => s.name);
    const stale = stages.filter((s) => s.status === 'desatualizado').map((s) => s.name);
    if (changed.length && stale.length) {
      problems.push(
        `changed since the last baseline: ${changed.join(', ')} — ` +
          `stale (untouched): ${stale.join(', ')}. ` +
          `Propagate the change (or confirm each one is unaffected) and run: ` +
          `node tools/check.mjs ${slug} --baseline`
      );
    }
  }

  return problems;
}

// Reads the state file's notes array (last 20, newest last) — used by baseline()
// to append and by the plain `check.mjs <slug>` report to print the latest one.
// `notas` is the pre-migration key: still read so an old state file keeps its history.
function readNotes(dir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.state.json'), 'utf8'));
    const notes = state.notes ?? state.notas;
    return Array.isArray(notes) ? notes : [];
  } catch {
    return [];
  }
}

function baseline(slug, force, note) {
  const dir = resolveDir(slug);
  if (!fs.existsSync(dir)) {
    console.error(`session not found: ${slug}`);
    process.exit(1);
  }
  // validate structure before writing the baseline — a baseline over a broken state freezes the problem.
  // (pending staleness does NOT block: resolving it is exactly the baseline's job)
  const structural = checkSession(slug).filter((p) => !/baseline/.test(p));
  if (structural.length && !force) {
    console.error(`invalid structure — fix it before recording the baseline (or use --force):\n- ${structural.join('\n- ')}`);
    process.exit(1);
  }
  const hashes = {};
  for (const name of ORDER) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) hashes[name] = hashFile(p);
  }
  // --note records what was confirmed unaffected by a premise change — the decision
  // to leave a downstream file untouched stops living only in the pilot's head.
  // Last 20 notes are kept, newest last; `check.mjs <slug>` (no flags) prints the latest.
  let notes = readNotes(dir);
  if (note) notes = [...notes, { at: new Date().toISOString(), text: note }].slice(-20);
  fs.writeFileSync(path.join(dir, '.state.json'), JSON.stringify({ hashes, at: new Date().toISOString(), notes }, null, 2));
  console.log(`baseline recorded for ${slug} (${Object.keys(hashes).length} files)${note ? ' — note recorded' : ''}`);
}

// --- deterministic review lints: whatever is regex/parse stays out of the LLM and lives here ---
const TAXONOMY = ['👤', '🌐', '🧭', '⚙️', '🗄️', '⚡', '📨', '⏱️', '📊', '🛡️', '🔌'];
const normVoc = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Sessions are written in English by default, but the ones written before that
// are in Portuguese and must keep linting identically — every heading, table
// header and fixed vocabulary below is therefore a LIST of accepted spellings,
// never a single language's.
const VOCAB = {
  lifecycle: ['Ciclo de vida', 'Lifecycle'],
  contexts: ['Contextos', 'Contexts'],
  deferred: ['Decisões adiadas', 'Deferred decisions'],
  marketRefs: ['Referências de mercado', 'Market references'],
  termHeader: ['| Termo |', '| Term |'],
  defense: /Defesa em 30s|30s defense/g,
};

// Markdown table lookup: finds the row whose text STARTS with one of headerPrefixes,
// treats the next line as the separator (skipped), and reads data rows contiguously —
// stops at the first line that has no "|" at all, per the domain templates' contract.
function findTable(text, headerPrefix) {
  const prefixes = Array.isArray(headerPrefix) ? headerPrefix : [headerPrefix];
  const lines = text.split('\n');
  const hi = lines.findIndex((l) => prefixes.some((p) => l.trim().startsWith(p)));
  if (hi < 0) return null;
  const cellsOf = (line) => {
    const c = line.split('|').map((x) => x.trim());
    if (c[0] === '') c.shift();
    if (c.at(-1) === '') c.pop();
    return c;
  };
  const rows = [];
  let i = hi + 1;
  if (lines[i] && /^\s*\|?\s*:?-{2,}/.test(lines[i])) i++; // separator row
  for (; i < lines.length && lines[i].includes('|'); i++) rows.push(cellsOf(lines[i]));
  return { header: cellsOf(lines[hi]), rows, headerLine: hi };
}

// Text of a "## <heading>" section, up to (excluding) the next "## " heading.
// `heading` may be a list of accepted spellings (English + the legacy Portuguese one).
function extractSection(text, heading) {
  const alts = (Array.isArray(heading) ? heading : [heading]).join('|');
  const m = new RegExp(`^##\\s+(?:${alts})\\s*$`, 'm').exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

// Content of the first ```mermaid fence in a block of text.
const extractMermaid = (text) => /```mermaid\n([\s\S]*?)```/.exec(text ?? '')?.[1] ?? null;
const extractMermaidAll = (text) => [...(text ?? '').matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

// stateDiagram-v2 edges: "A --> B" (labels ignored); [*] is the pseudostate, not a real state.
function parseStateDiagram(src) {
  const edges = [];
  for (const raw of (src ?? '').split('\n')) {
    const m = raw.trim().match(/^(\[\*\]|[A-Za-z0-9_]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_]+)/);
    if (m) edges.push({ from: m[1], to: m[2] });
  }
  return edges;
}

// --- number parsing shared by [capacity] and [numbers]: a stale number after a
// premise change is the defect the mesa catches in seconds and the lint didn't
// used to. Brazilian formatting (2.000,50) and plain (2000.5) both parse; k/mil/M
// are magnitude multipliers, so "2.000 ≈ 2 mil ≈ 2000 ≈ 2k" compare equal. -----
const NUMRAW = '\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?';
function parseBrNumber(raw) {
  let s = raw.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 2.000,50
  else if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.'); // 6,6
  return parseFloat(s);
}
const numbersClose = (a, b) => Math.abs(a - b) < Math.max(1e-6, Math.abs(b) * 0.005);
const MAGNITUDE = { k: 1e3, mil: 1e3, thousand: 1e3, M: 1e6 };
// Every number found in free text, expanded by a following k/mil/M magnitude word if present.
// Used for the side that's just "does this quantity appear anywhere" (capacity items,
// 20-estimates.md, 10-requirements.md) — no unit token required.
function extractMagnitudeNumbers(text) {
  const out = new Set();
  const re = new RegExp(`(${NUMRAW})\\s?(k|mil|thousand|M)?(?![A-Za-zÀ-ÿ])`, 'g');
  for (const m of (text ?? '').matchAll(re)) {
    const v = parseBrNumber(m[1]);
    if (!Number.isNaN(v)) out.add(v * (MAGNITUDE[m[2]] ?? 1));
  }
  return out;
}
// Numbers that carry a UNIT as a whole token — this is what [numbers] flags, and
// requiring the unit is what keeps "10 sessões" from being read as "10 s" and a
// bare HTTP code / year / #N (no unit at all) from ever matching.
function extractNumUnitTokens(text) {
  if (!text) return [];
  const out = [];
  // number + magnitude/duration/percent unit, directly adjacent (optional single space)
  // the magnitude word is applied to the value ("150k" → 150000) so it compares equal
  // to the expanded number on the backing side
  const reA = new RegExp(`(${NUMRAW})\\s?(k|mil|thousand|M|KB|MB|GB|ms|min|h|%)(?![A-Za-zÀ-ÿ])`, 'g');
  for (const m of text.matchAll(reA))
    out.push({ text: m[0].trim(), value: parseBrNumber(m[1]) * (MAGNITUDE[m[2]] ?? 1) });
  // rate units fused to the noun they describe ("avisos/s", "requisições/dia") — the
  // word in between is why these can't share reA's "directly adjacent" pattern
  const reB = new RegExp(`(${NUMRAW})\\s+[A-Za-zÀ-ÿ]+(?:\\/s|\\/dia|\\/day)`, 'g');
  for (const m of text.matchAll(reB)) out.push({ text: m[0].trim(), value: parseBrNumber(m[1]) });
  // currency prefix
  const reC = new RegExp(`(?:R\\$|US\\$|\\$)\\s?(${NUMRAW})\\s?(k|mil|thousand|M)?(?![A-Za-zÀ-ÿ])`, 'g');
  for (const m of text.matchAll(reC))
    out.push({ text: m[0].trim(), value: parseBrNumber(m[1]) * (MAGNITUDE[m[2]] ?? 1) });
  return out;
}

// Single source of truth for what `--lint` checks: id, what it requires, what it
// reports. `node tools/check.mjs --rules` prints this list; every lint message
// starts with the matching [id] (enforced below — an id used but not registered
// here is a programming error, not something to fail silently on).
const RULES = [
  { id: 'subgraphs', output: 'FAIL', requires: 'diagram.mmd groups nodes into at least 2 subgraphs' },
  { id: 'coverage', output: 'FAIL', requires: 'every non-actor diagram node has a scorecard.components entry (sheet); every non-actor, non-external (🔌) node also has a scorecard.costs.items entry; a sheet with no diagram node is reported as a warning (orphan)' },
  { id: 'queue', output: 'FAIL', requires: 'every queue/topic node (diagram + its sheet) declares a DLQ+reprocessing path, or an explicit accepted loss' },
  { id: 'flow-start', output: 'FAIL', requires: 'the "1·" numbered edge starts at an actor (the clients subgraph)' },
  { id: 'direction', output: 'warning', requires: 'no numbered edge whose label starts with an HTTP status code or response/returns (resposta/devolve/retorna) — a response drawn as the initiative' },
  { id: 'emoji', output: 'warning', requires: 'every diagram node label includes one of the taxonomy emoji' },
  { id: 'zoom', output: 'warning', requires: 'node labels ≤ 3 lines and the diagram ≤ 18 nodes (past that, add a system node + a zoom sub-diagram — never merge unrelated components to fit)' },
  { id: 'telemetry', output: 'warning', requires: 'no node that looks like a generic telemetry/observability collector' },
  { id: 'actors', output: 'warning', requires: 'at least one actor besides the end user' },
  { id: 'jargon', output: 'FAIL', requires: 'no internal-mechanics jargon (commands, skills, work rituals) in any session .md, unless scoped-exempted in meta.json allowed_jargon with a non-empty reason' },
  { id: 'retired-stage', output: 'warning', requires: 'no file on disk named after a stage retired from the canonical pipeline (tools/pipeline.mjs RETIRED_STAGES)' },
  { id: 'defense', output: 'warning', requires: 'every trade-off entry in 40-tradeoffs.md has a "30s defense" line ("Defesa em 30s" in a Portuguese session)' },
  { id: 'numbering', output: 'warning', requires: '40-tradeoffs.md "## N." headings are numbered sequentially from 1' },
  { id: 'deferred', output: 'warning', requires: 'no "Deferred decisions" line in 40-tradeoffs.md promising something a stage already delivers' },
  { id: 'guardrails-sum', output: 'FAIL', requires: 'scorecard.guardrails pass+fail+na+premises+accepted_risks equals the item count in guardrails.md' },
  { id: 'capacity', output: 'warning', requires: 'every scorecard.capacity number (magnitude-normalized: 2.000 ≈ 2 mil ≈ 2000 ≈ 2k) appears in 20-estimates.md' },
  {
    id: 'numbers',
    output: 'warning',
    requires:
      'every number-with-unit (k, mil/thousand, M, KB, MB, GB, ms, s, min, h, %, /s, /dia, currency) in 40-tradeoffs.md, 25-domain.md, 30-design.md, and components[].purpose/scaling/failure appears in 20-estimates.md or 10-requirements.md',
  },
  { id: 'domain-invariants', output: 'FAIL', requires: '25-domain.md invariants table: header starting "| ID |", INV-n ids, no empty cells, fixed Prevention vocabulary' },
  { id: 'domain-lifecycle', output: 'FAIL', requires: '25-domain.md "## Lifecycle" stateDiagram-v2: every destination state has an outgoing edge or terminates at [*]; matches 35-data-model.md\'s ER state enum' },
  { id: 'domain-aggregates', output: 'FAIL/warning', requires: 'each "### Aggregate: <name>" mentions cardinality (FAIL if not) and cites an INV-n or says the boundary is justified (warning if neither)' },
  { id: 'domain-vocabulary', output: 'FAIL', requires: 'every "## Contexts" entry owns a vocabulary term; every vocabulary owner is a declared context' },
  { id: 'domain-model-vocabulary', output: 'FAIL', requires: "35-data-model.md's vocabulary terms match 25-domain.md's" },
  {
    id: 'dag-prose',
    output: 'FAIL',
    requires:
      "CLAUDE.md's DAG prose line matches the canonical order in tools/pipeline.mjs ORDER (repo-wide: runs without a slug and inside --lint, never inside --hook)",
  },
];
const RULE_IDS = new Set(RULES.map((r) => r.id));

// Emit helpers shared by every predicate below: validate the id is registered
// (throwing is the point — an unregistered id must break loudly, in CI/dev, not
// pass silently in someone's session) and prefix every message with [id].
function makeEmitters(fails, warnings, notChecked) {
  const assertRegistered = (id) => {
    if (!RULE_IDS.has(id))
      throw new Error(`internal error: lint id "${id}" is not registered in RULES — run --rules to see the registered ids`);
  };
  return {
    fail: (id, msg) => {
      assertRegistered(id);
      fails.push(`[${id}] ${msg}`);
    },
    warning: (id, msg) => {
      assertRegistered(id);
      warnings.push(`[${id}] ${msg}`);
    },
    notChecked: (id, msg) => {
      assertRegistered(id);
      notChecked.push(`[${id}] ${msg}`);
    },
  };
}

// Repo-wide: CLAUDE.md's DAG prose (kept in sync by hand) vs. the canonical order
// in ORDER. Returns plain messages (no [id] prefix — callers format that, since
// this runs both inside a session's --lint and in the no-slug structural check).
function dagProseProblems() {
  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  } catch {}
  const m = /pipeline is a DAG[^:]*:\s*`([^`]+)`/.exec(claudeMd);
  if (!m) return ['could not find the DAG prose line in CLAUDE.md to check against tools/pipeline.mjs ORDER'];
  const files = [];
  for (const tok of m[1].split('→').map((s) => s.trim())) {
    if (tok === 'diagram/scorecard') {
      files.push('diagram.mmd', 'scorecard.json');
      continue;
    }
    files.push(/\.\w+$/.test(tok) ? tok : `${tok}.md`);
  }
  const a = files.join(' → ');
  const b = ORDER.join(' → ');
  return a === b ? [] : [`CLAUDE.md's DAG line doesn't match tools/pipeline.mjs ORDER:\n    CLAUDE.md:    ${a}\n    pipeline.mjs: ${b}`];
}

function lintSession(slug) {
  const dir = resolveDir(slug);
  if (!fs.existsSync(dir)) {
    console.error(`session not found: ${slug}`);
    process.exit(1);
  }
  const read = (n) => {
    try {
      return fs.readFileSync(path.join(dir, n), 'utf8');
    } catch {
      return null;
    }
  };
  const fails = [];
  const warnings = [];
  const notCheckeds = [];
  const { fail, warning, notChecked } = makeEmitters(fails, warnings, notCheckeds);
  let sc = null;
  try {
    sc = JSON.parse(read('scorecard.json'));
  } catch {}
  const comps = sc?.components ?? [];
  const costs = sc?.costs?.items ?? [];
  const diagram = read('diagram.mmd');

  if (diagram) {
    const { nodes, edges, subgraphs } = parseDiagram(diagram);
    if (subgraphs.length < 2) fail('subgraphs', 'diagram has no groupings (subgraphs) — illegible');
    const isActor = (n) => /cliente|client/i.test(n.subgraph ?? '') || n.label.includes('👤');
    const isExternal = (n) => n.label.includes('🔌');
    // token-overlap ≥ 0.5 — same criterion the viewer uses to match a node ↔ sheet
    const normTok = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\\n/g, ' ');
    const tokens = (s) => new Set(normTok(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2));
    const matches = (label, name) => {
      const L = tokens(label);
      const T = [...tokens(name)];
      return T.length > 0 && T.filter((t) => L.has(t)).length / T.length >= 0.5;
    };
    const hasComp = (n) => comps.some((c) => matches(n.label, c.name));
    const hasCost = (n) => costs.some((c) => matches(n.label, c.component));
    const noEmoji = [];
    for (const n of nodes) {
      if (isActor(n)) continue;
      if (!hasComp(n)) fail('coverage', `node "${n.id}" has no entry in the scorecard's components (legend)`);
      // external (🔌) dependencies get a sheet but never a cost line — it's someone else's infrastructure
      if (!isExternal(n) && !hasCost(n)) fail('coverage', `node "${n.id}" has no entry in the scorecard's costs.items`);
      if (n.lines > 3) warning('zoom', `node "${n.id}" has a ${n.lines}-line label (budget: 3 — detail belongs in the sheet)`);
      if (!TAXONOMY.some((e) => n.label.includes(e))) noEmoji.push(n.id);
      // queue = shape [[...]] or a label that STARTS by naming a queue ("queue page" doesn't count)
      const isQueue = n.shape === '[[' || /^"?\s*(fila|queue|t[óo]pico|topic|stream)\b/i.test(n.label);
      if (isQueue) {
        const sheet = comps.find((c) => matches(n.label, c.name));
        const text = `${n.label} ${sheet?.purpose ?? ''} ${sheet?.failure ?? ''}`;
        if (!/DLQ|perda aceita|accepted loss|descarte|discard|dead.?letter/i.test(text))
          fail('queue', `queue "${n.id}" has no declared failure destination (DLQ + reprocessing, or "accepted loss")`);
      }
    }
    if (noEmoji.length) warning('emoji', `${noEmoji.length} node(s) without a taxonomy emoji: ${noEmoji.join(', ')}`);
    for (const n of nodes)
      if (/observabilidad|observabilit|telemetria|telemetry|monitor(amento|ing)\b/i.test(n.label))
        warning(
          'telemetry',
          `node "${n.id}" looks like telemetry collection — universal collection isn't drawn (signals live in operations); keep it only if it's a component of the problem itself`
        );
    if (nodes.length > 18)
      warning('zoom', `diagram with ${nodes.length} nodes (budget: 18 — add a system node + a zoom sub-diagram rather than merging unrelated components)`);
    // the reverse of the coverage check: a sheet whose node was merged away or renamed is an
    // orphan — its cost still counts in the total while the diagram no longer shows the component
    for (const c of comps)
      if (!nodes.some((n) => !isActor(n) && matches(n.label, c.name)))
        warning('coverage', `component "${c.name}" has a sheet but no diagram node (orphaned when a node was merged or renamed?)`);
    const numbered = edges.filter((e) => /^"?\s*\d+\s*[·.]/.test(e.label));
    if (!numbered.length) fail('flow-start', 'no numbered edge — the main flow must tell the story (1·, 2·…)');
    else {
      const first = numbered.find((e) => /^"?\s*1\s*[·.]/.test(e.label));
      const fromNode = first && nodes.find((n) => n.id === first.from);
      if (first && fromNode && !isActor(fromNode))
        fail('flow-start', `edge 1· starts from "${first.from}" — the flow must start at the user's arrival (clients subgraph)`);
    }
    // direction = who initiates: a numbered edge whose label opens with a response
    // (HTTP status, or response/returns — resposta/devolve/retorna) is drawn backwards
    for (const e of edges) {
      const m = e.label.match(/^"?\s*\d+\s*[·.]\s*(.*)$/);
      if (m && /^(?:\d{3}\b|resposta|devolve|retorna|response|returns?)/i.test(m[1]))
        warning(
          'direction',
          `edge ${e.from}->${e.to} — label "${e.label}" opens with a response (HTTP status or response/returns) though it's drawn as the numbered initiative; direction should follow who initiates the action, not who answers`
        );
    }
    const actors = nodes.filter(isActor);
    if (actors.length === 1) warning('actors', 'no actor besides the end user (organizer/back office/ops — almost every system has one)');
  } else {
    fail('subgraphs', 'diagram.mmd missing');
  }

  // HTML comments (e.g. a stage template's lint-contract header) are documentation,
  // never artifact content — strip them before any content check, jargon included.
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {}
  // `jargao_permitido` is the pre-migration key: still read, so a session that
  // hasn't been through tools/migrate.mjs keeps its scoped exceptions.
  const rawAllowed = meta?.allowed_jargon ?? meta?.jargao_permitido;
  const allowedJargon = rawAllowed && typeof rawAllowed === 'object' ? rawAllowed : {};
  for (const f of ORDER.filter((n) => n.endsWith('.md'))) {
    const c = read(f);
    if (!c) continue;
    for (const [i, line] of stripHtmlComments(c).split('\n').entries()) {
      const m = JARGON.exec(line);
      if (!m) continue;
      const token = m[0];
      // scoped exception: meta.json declares the term is the design's own subject, with a reason
      const exemptKey = Object.keys(allowedJargon).find(
        (k) => token.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(token.toLowerCase())
      );
      if (exemptKey) {
        const reason = String(allowedJargon[exemptKey] ?? '').trim();
        if (reason) continue; // valid exception, scoped with a reason — not a finding
        fail(
          'jargon',
          `internal jargon in ${f}:${i + 1} ("${token}") — meta.json's allowed_jargon["${exemptKey}"] has no reason recorded, exception invalid`
        );
        continue;
      }
      fail('jargon', `internal jargon in ${f}:${i + 1} ("${token}") — artifacts are shareable`);
    }
  }

  // retired stages: a file on disk with a name that left the pipeline
  for (const f of RETIRED_STAGES)
    if (fs.existsSync(path.join(dir, f)))
      warning('retired-stage', `${f} exists on disk but is no longer part of the pipeline — hidden from both panels; safe to delete`);

  const tradeoffsRaw = read('40-tradeoffs.md');
  const tradeoffs = tradeoffsRaw ? stripHtmlComments(tradeoffsRaw) : null;
  if (tradeoffs) {
    const fixedSections = [...VOCAB.deferred, ...VOCAB.marketRefs].join('|');
    const entries = (tradeoffs.match(new RegExp(`^##\\s+(?!${fixedSections})`, 'gm')) ?? []).length;
    const defenses = (tradeoffs.match(VOCAB.defense) ?? []).length;
    if (entries > defenses) warning('defense', `${entries - defenses} trade-off(s) in 40-tradeoffs.md without a "30s defense" line`);

    const entryNums = [...tradeoffs.matchAll(/^##\s+(\d+)\.\s+.+$/gm)].map((m) => Number(m[1]));
    for (let i = 0; i < entryNums.length; i++) {
      if (entryNums[i] !== i + 1) {
        warning('numbering', `40-tradeoffs.md — trade-off headings are numbered ${entryNums.join(', ')}, not sequential from 1`);
        break;
      }
    }

    // a "Deferred decisions" line promising something a stage already delivers
    const deferredSection = extractSection(tradeoffs, VOCAB.deferred) ?? '';
    const DEFERRED_KEYWORDS = [
      { re: /dom[ií]nio|domain/i, file: '25-domain.md' },
      { re: /modelo(?:\s+de\s+dados)?|modelagem|data\s+model|modelling|modeling/i, file: '35-data-model.md' },
      { re: /\bpoc\b|\bmvp\b/i, file: '70-poc.md' },
      { re: /d[uú]vidas|faq|questions/i, file: '90-faq.md' },
    ];
    for (const rawLine of deferredSection.split('\n')) {
      const line = rawLine.trim();
      if (!/^-\s/.test(line)) continue;
      for (const kw of DEFERRED_KEYWORDS) {
        if (!kw.re.test(line)) continue;
        let delivered = false;
        try {
          delivered = fs.readFileSync(path.join(dir, kw.file), 'utf8') !== TEMPLATE_BY_FILE[kw.file];
        } catch {}
        if (delivered) warning('deferred', `40-tradeoffs.md — "${line}" is listed under deferred decisions, but ${kw.file} already has content`);
      }
    }
  }

  // --- Domain & Modeling deterministic predicates (judge guardrails items 30-34) ---
  {
    const domainRaw = read('25-domain.md');
    const modelRaw = read('35-data-model.md');
    const domain = domainRaw ? stripHtmlComments(domainRaw) : null;
    const model = modelRaw ? stripHtmlComments(modelRaw) : null;
    // fixed "Prevention" vocabulary, in both languages
    const PREVENTION = [
      'prevenido no banco',
      'prevenido no código',
      'detectado depois',
      'só coberto por teste',
      'prevented in the database',
      'prevented in code',
      'detected later',
      'only covered by test',
    ];
    const isPremise = (s) => /premissa-a-validar|premise-to-validate/i.test(s ?? '');

    // [domain-invariants]
    if (!domain) {
      notChecked('domain-invariants', 'no 25-domain.md in this session');
    } else {
      const table = findTable(domain, '| ID |');
      if (!table) notChecked('domain-invariants', 'no invariants table (header starting with "| ID |") in 25-domain.md');
      else
        table.rows.forEach((row, ri) => {
          const id = row[0] ?? '';
          if (row.some((c) => !c)) {
            fail('domain-invariants', `25-domain.md — invariant row ${ri + 1} (${id || '?'}) has an empty cell`);
            return;
          }
          if (!/^INV-\d+$/.test(id)) fail('domain-invariants', `25-domain.md — invariant id "${id}" doesn't match INV-n`);
          const prevention = row[2] ?? '';
          if (!isPremise(prevention) && !PREVENTION.some((p) => normVoc(prevention) === normVoc(p)))
            fail('domain-invariants', `25-domain.md — "${id}" has "Prevention" outside the fixed vocabulary: "${prevention}"`);
        });
    }

    // [domain-lifecycle]
    if (!domain) {
      notChecked('domain-lifecycle', 'no 25-domain.md in this session');
    } else {
      const section = extractSection(domain, VOCAB.lifecycle);
      // a design with several lifecycles (one entity per block) is one machine per block:
      // read every stateDiagram-v2 block in the section, not just the first fence
      const mermaidSrc = section
        ? extractMermaidAll(section).filter((b) => /stateDiagram-v2/.test(b)).join('\n') || null
        : null;
      if (!mermaidSrc) {
        notChecked('domain-lifecycle', 'no "## Lifecycle" section with a stateDiagram-v2 block in 25-domain.md');
      } else {
        const edges = parseStateDiagram(mermaidSrc);
        const sources = new Set(edges.map((e) => e.from));
        const destinations = new Set(edges.map((e) => e.to).filter((t) => t !== '[*]'));
        for (const state of destinations)
          if (!sources.has(state))
            fail(
              'domain-lifecycle',
              `25-domain.md — state "${state}" is a transition's destination with no outgoing edge and no [*] termination`
            );
        // cross-file: state enum values declared on the Model's erDiagram must all exist here
        if (model) {
          const lifecycleStates = new Set([...sources, ...destinations].map(normVoc));
          const modelEr = extractMermaid(model) ?? '';
          // enum values come either inline (attribute comment, rendered inside the entity box)
          // or on a `%% <attribute>: a|b|c` line right below the attribute — invisible in
          // the render, which keeps a long enum from stretching the whole table
          const enumDecls = [
            ...modelEr.matchAll(/\b(?:state|estado)\b[^\n"]*"([^"]+)"/gi),
            ...modelEr.matchAll(/^\s*%%\s*\w*(?:state|estado)\w*\s*:\s*([^\n]+?)\s*$/gim),
          ];
          for (const m of enumDecls)
            for (const v of m[1].split('|').map((x) => x.trim()).filter(Boolean))
              if (!lifecycleStates.has(normVoc(v)))
                fail(
                  'domain-lifecycle',
                  `35-data-model.md declares state "${v}" that doesn't exist in 25-domain.md's lifecycle`
                );
        }
      }
    }

    // [domain-aggregates]
    if (!domain) {
      notChecked('domain-aggregates', 'no 25-domain.md in this session');
    } else {
      const matches = [...domain.matchAll(/^###\s+(?:Agregado|Aggregate):\s*(.+)$/gm)];
      if (!matches.length) {
        notChecked('domain-aggregates', 'no "### Aggregate: <name>" heading in 25-domain.md');
      } else {
        matches.forEach((m, i) => {
          const name = m[1].trim();
          const start = m.index + m[0].length;
          const end = i + 1 < matches.length ? matches[i + 1].index : domain.length;
          const body = domain.slice(start, end);
          if (!/cardinalidade|cardinality/i.test(body)) fail('domain-aggregates', `25-domain.md — "Aggregate: ${name}" doesn't mention cardinality`);
          if (!/INV-\d+/.test(body) && !/justificad|justified/i.test(body))
            warning('domain-aggregates', `25-domain.md — "Aggregate: ${name}" cites no INV-n and doesn't say the boundary is justified`);
        });
      }
    }

    // [domain-vocabulary]
    if (!domain) {
      notChecked('domain-vocabulary', 'no 25-domain.md in this session');
    } else {
      const ctxSection = extractSection(domain, VOCAB.contexts);
      // markdown emphasis/code around the name ("- **Collection** — …") is formatting, not identity
      const stripMd = (s) => s.replace(/[*_`]/g, '').trim();
      const declaredContexts = ctxSection
        ? [...ctxSection.matchAll(/^-\s*(.+)$/gm)].map((m) => stripMd(m[1].split(/[—:-]/)[0])).filter(Boolean)
        : [];
      const vocabTable = findTable(domain, VOCAB.termHeader);
      if (!declaredContexts.length || !vocabTable) {
        notChecked('domain-vocabulary', 'no "## Contexts" list or no vocabulary table in 25-domain.md');
      } else {
        const ownersWithTerms = new Set();
        for (const row of vocabTable.rows) {
          const owner = stripMd(row[1] ?? '');
          ownersWithTerms.add(normVoc(owner));
          if (!declaredContexts.some((c) => normVoc(c) === normVoc(owner)))
            fail('domain-vocabulary', `25-domain.md — vocabulary owner "${owner}" is not a declared context`);
        }
        for (const c of declaredContexts)
          if (!ownersWithTerms.has(normVoc(c)))
            fail('domain-vocabulary', `25-domain.md — context "${c}" has no term in the vocabulary table`);
      }
    }

    // [domain-model-vocabulary] — the Model's vocabulary must match the Domain's
    if (!domain || !model) {
      notChecked('domain-model-vocabulary', 'needs both 25-domain.md and 35-data-model.md');
    } else {
      const domVocab = findTable(domain, VOCAB.termHeader);
      const modVocab = findTable(model, VOCAB.termHeader);
      if (!domVocab || !modVocab) {
        notChecked('domain-model-vocabulary', 'vocabulary table missing in one of the two files');
      } else {
        const domTerms = new Set(domVocab.rows.map((r) => normVoc(r[0])));
        for (const row of modVocab.rows) {
          const term = row[0] ?? '';
          if (term && !domTerms.has(normVoc(term)))
            fail('domain-model-vocabulary', `35-data-model.md — term "${term}" doesn't match 25-domain.md's vocabulary`);
        }
      }
    }
  }

  // --- [capacity] and [numbers]: catch a stale number left behind after a premise
  // change propagated through some files but not all (see CLAUDE.md's propagation
  // protocol) ---
  {
    const estimatesRaw = read('20-estimates.md');
    const requirementsRaw = read('10-requirements.md');
    const backingNums = extractMagnitudeNumbers(
      `${estimatesRaw ? stripHtmlComments(estimatesRaw) : ''}\n${requirementsRaw ? stripHtmlComments(requirementsRaw) : ''}`
    );

    // [capacity]
    const capacity = sc?.capacity ?? [];
    if (!capacity.length) {
      notChecked('capacity', 'no scorecard.capacity items');
    } else if (!estimatesRaw) {
      notChecked('capacity', 'no 20-estimates.md in this session to check numbers against');
    } else {
      for (const item of capacity) {
        const itemNums = [...extractMagnitudeNumbers(String(item.value ?? ''))];
        if (!itemNums.length) continue; // nothing numeric in this item (a qualitative value)
        const found = itemNums.some((n) => [...backingNums].some((e) => numbersClose(e, n)));
        if (!found)
          warning(
            'capacity',
            `scorecard.capacity "${item.name}" = "${item.value}" doesn't appear in 20-estimates.md (stale number after a premise change?)`
          );
      }
    }

    // [numbers]
    if (!estimatesRaw && !requirementsRaw) {
      notChecked('numbers', 'no 20-estimates.md or 10-requirements.md in this session to check numbers against');
    } else {
      const numberSources = [
        ['40-tradeoffs.md', tradeoffs],
        ['25-domain.md', read('25-domain.md')],
        ['30-design.md', read('30-design.md')],
      ];
      for (const [fname, raw] of numberSources) {
        if (!raw) continue;
        const lines = stripHtmlComments(raw).split('\n');
        lines.forEach((line, i) => {
          for (const tok of extractNumUnitTokens(line)) {
            if (![...backingNums].some((n) => numbersClose(n, tok.value)))
              warning(
                'numbers',
                `${fname}:${i + 1} — "${tok.text}" doesn't appear in 20-estimates.md nor 10-requirements.md (stale number after propagation?)`
              );
          }
        });
      }
      for (const c of comps)
        for (const field of ['purpose', 'scaling', 'failure'])
          for (const tok of extractNumUnitTokens(c[field] ?? ''))
            if (![...backingNums].some((n) => numbersClose(n, tok.value)))
              warning(
                'numbers',
                `scorecard.components["${c.name}"].${field} — "${tok.text}" doesn't appear in 20-estimates.md nor 10-requirements.md (stale number after propagation?)`
              );
    }
  }

  // guardrails closed sum: pass+fail+na+premises+accepted_risks must equal the checklist size in
  // guardrails.md — an item nobody has judged yet can't silently disappear from the count.
  {
    let guardrailsMd = '';
    try {
      guardrailsMd = fs.readFileSync(path.join(ROOT, 'guardrails.md'), 'utf8');
    } catch {}
    const totalItems = (guardrailsMd.match(/^\d+\.\s/gm) ?? []).length;
    const g = sc?.guardrails;
    if (!totalItems) {
      notChecked('guardrails-sum', 'root guardrails.md unreadable');
    } else if (!g) {
      notChecked('guardrails-sum', 'no guardrails block in scorecard.json yet');
    } else {
      const { pass = 0, fail: fa = 0, na = 0, premises = 0, accepted_risks: acceptedRisks = 0 } = g;
      const sum = pass + fa + na + premises + acceptedRisks;
      if (sum !== totalItems)
        fail(
          'guardrails-sum',
          `sum is ${sum} (${pass} pass + ${fa} fail + ${na} n/a + ${premises} premise(s) + ${acceptedRisks} accepted risk(s)), expected ${totalItems} — guardrails.md has ${totalItems} items`
        );
    }
  }

  // repo-wide: CLAUDE.md's DAG prose vs. tools/pipeline.mjs ORDER — runs inside --lint too (never inside --hook)
  for (const p of dagProseProblems()) fail('dag-prose', p);

  for (const f of fails) console.log(`FAIL: ${f}`);
  for (const a of warnings) console.log(`warning: ${a}`);
  for (const n of notCheckeds) console.log(`not checked: ${n}`);
  console.log(`\nlint: ${fails.length} fail(s) · ${warnings.length} warning(s) · ${notCheckeds.length} not checked`);
  return fails.length === 0;
}

function allSlugs() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// --- CLI ---
const args = process.argv.slice(2);
const hookMode = args.includes('--hook');
const doBaseline = args.includes('--baseline');
const doLint = args.includes('--lint');
const envSlug = process.env.SD_SESSION?.trim() || null;
const slugArg = args.find((a) => !a.startsWith('--')) ?? envSlug;

if (args.includes('--rules')) {
  const idWidth = Math.max(...RULES.map((r) => r.id.length + 2));
  for (const r of RULES) console.log(`${`[${r.id}]`.padEnd(idWidth)} ${r.output.padEnd(12)} — ${r.requires}`);
  process.exit(0);
}

if (doBaseline) {
  if (!slugArg) {
    console.error('usage: node tools/check.mjs <slug> --baseline [--force] [--note "<text>"]');
    process.exit(1);
  }
  const noteIdx = args.indexOf('--note');
  const note = noteIdx >= 0 ? args[noteIdx + 1] : null;
  if (noteIdx >= 0 && !note) {
    console.error('--note with no value');
    process.exit(1);
  }
  baseline(slugArg, args.includes('--force'), note);
  process.exit(0);
}

if (doLint) {
  if (!slugArg) {
    console.error('usage: node tools/check.mjs <slug> --lint');
    process.exit(1);
  }
  // --lint is a gate: a FAIL exits != 0 so it can be used as a gate, like hook mode
  process.exit(lintSession(slugArg) ? 0 : 1);
}

let slugs = slugArg ? [slugArg] : allSlugs();
// hook scoped by SD_SESSION: a session that doesn't exist yet isn't a problem — it just
// means the agent hasn't run new-session yet; nothing to check
if (hookMode && envSlug && slugArg === envSlug && !fs.existsSync(resolveDir(envSlug))) slugs = [];

// In hook mode, a session with activity in the last 2 minutes is WORK IN PROGRESS
// from some conversation — its owner propagates and baselines in their own turn.
// Without this grace period, one conversation's Stop hook would block mid-turn for another.
const inFlight = (slug) => {
  const dir = resolveDir(slug);
  let m = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('.')) continue;
      m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs);
    }
  } catch {}
  return Math.abs(Date.now() - m) < 120_000;
};

const report = [];
for (const slug of slugs) {
  if (hookMode && inFlight(slug)) continue;
  for (const p of checkSession(slug)) report.push(`[${slug}] ${p}`);
}
// repo-wide rule (CLAUDE.md's DAG prose vs. tools/pipeline.mjs ORDER): runs on the
// plain "check everything" call, never inside the end-of-turn hook (too noisy there
// for a documentation-drift concern unrelated to the session's own progress).
if (!hookMode && !slugArg) for (const p of dagProseProblems()) report.push(`[dag-prose] ${p}`);

if (hookMode) {
  // read from the Stop hook: exit 2 blocks the turn from ending and returns
  // stderr to the agent. If the hook already blocked once in this chain
  // (stop_hook_active), release with a warning to avoid an infinite loop.
  let stopHookActive = false;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    stopHookActive = !!JSON.parse(stdin).stop_hook_active;
  } catch {}
  if (!report.length) process.exit(0);
  const msg = `Inconsistent system design sessions:\n- ${report.join('\n- ')}`;
  if (stopHookActive) {
    console.log(`${msg}\n(warning: this chain already had a block this turn; releasing to avoid a loop)`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(2);
}

// single-session call (not the bulk "check everything"): print the latest baseline
// note, if any — the decision to leave a downstream file untouched shouldn't live
// only in the pilot's head.
if (slugArg) {
  const last = readNotes(resolveDir(slugArg)).at(-1);
  if (last) console.log(`note (${String(last.at ?? last.quando).slice(0, 10)}): ${last.text ?? last.texto}`);
}

if (!report.length) {
  console.log(`ok — ${slugs.length} session(s) consistent`);
} else {
  console.log(report.map((r) => `✗ ${r}`).join('\n'));
  process.exit(1);
}
