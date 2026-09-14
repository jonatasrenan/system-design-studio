// Consistency checker for sessions.
//
// Two kinds of checks, both deterministic:
//  - structural: valid meta.json/scorecard.json; a "concluido" session requires
//    a review to be present and guardrails with no FALHA.
//  - staleness: the pipeline is a linear DAG — the canonical order is ORDER, in
//    pipeline.mjs (also restated in prose in CLAUDE.md; the [dag-prosa] predicate
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
//   node tools/check.mjs --regras         # lists every lint predicate: id, what it requires, what it reports
//   node tools/check.mjs --hook           # Stop-hook mode: exit 2 blocks the turn
//
// `--regras` is the single source of truth for what `--lint` checks — every message
// the lint prints starts with the matching [id]; read `--regras` instead of the
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
    for (const k of ['title', 'mode', 'status'])
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

  if (meta?.status === 'concluido') {
    if (!fs.existsSync(file('45-review.md')))
      problems.push('status "concluido" without 45-review.md (run the guardrails review)');
    const g = scorecard?.guardrails;
    if (!g) problems.push('status "concluido" without a guardrails block in the scorecard');
    else if (g.falha > 0) problems.push(`status "concluido" with ${g.falha} open FALHA(s) in the guardrails`);
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
function readNotas(dir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.state.json'), 'utf8'));
    return Array.isArray(state.notas) ? state.notas : [];
  } catch {
    return [];
  }
}

function baseline(slug, force, nota) {
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
  // --nota records what was confirmed unaffected by a premise change — the decision
  // to leave a downstream file untouched stops living only in the pilot's head.
  // Last 20 notes are kept, newest last; `check.mjs <slug>` (no flags) prints the latest.
  let notas = readNotas(dir);
  if (nota) notas = [...notas, { quando: new Date().toISOString(), texto: nota }].slice(-20);
  fs.writeFileSync(path.join(dir, '.state.json'), JSON.stringify({ hashes, at: new Date().toISOString(), notas }, null, 2));
  console.log(`baseline recorded for ${slug} (${Object.keys(hashes).length} files)${nota ? ' — note recorded' : ''}`);
}

// --- deterministic review lints: whatever is regex/parse stays out of the LLM and lives here ---
const TAXONOMY = ['👤', '🌐', '🧭', '⚙️', '🗄️', '⚡', '📨', '⏱️', '📊', '🛡️', '🔌'];
const normVoc = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Markdown table lookup: finds the row whose text STARTS with headerPrefix, treats
// the next line as the separator (skipped), and reads data rows contiguously —
// stops at the first line that has no "|" at all, per the domain templates' contract.
function findTable(text, headerPrefix) {
  const lines = text.split('\n');
  const hi = lines.findIndex((l) => l.trim().startsWith(headerPrefix));
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
function extractSection(text, heading) {
  const m = new RegExp(`^##\\s+${heading}\\s*$`, 'm').exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

// Content of the first ```mermaid fence in a block of text.
const extractMermaid = (text) => /```mermaid\n([\s\S]*?)```/.exec(text ?? '')?.[1] ?? null;

// stateDiagram-v2 edges: "A --> B" (labels ignored); [*] is the pseudostate, not a real state.
function parseStateDiagram(src) {
  const edges = [];
  for (const raw of (src ?? '').split('\n')) {
    const m = raw.trim().match(/^(\[\*\]|[A-Za-z0-9_]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_]+)/);
    if (m) edges.push({ from: m[1], to: m[2] });
  }
  return edges;
}

// --- number parsing shared by [capacity] and [numeros]: a stale number after a
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
const MAGNITUDE = { k: 1e3, mil: 1e3, M: 1e6 };
// Every number found in free text, expanded by a following k/mil/M magnitude word if present.
// Used for the side that's just "does this quantity appear anywhere" (capacity items,
// 20-estimativas.md, 10-requisitos.md) — no unit token required.
function extractMagnitudeNumbers(text) {
  const out = new Set();
  const re = new RegExp(`(${NUMRAW})\\s?(k|mil|M)?(?![A-Za-zÀ-ÿ])`, 'g');
  for (const m of (text ?? '').matchAll(re)) {
    const v = parseBrNumber(m[1]);
    if (!Number.isNaN(v)) out.add(v * (MAGNITUDE[m[2]] ?? 1));
  }
  return out;
}
// Numbers that carry a UNIT as a whole token — this is what [numeros] flags, and
// requiring the unit is what keeps "10 sessões" from being read as "10 s" and a
// bare HTTP code / year / #N (no unit at all) from ever matching.
function extractNumUnitTokens(text) {
  if (!text) return [];
  const out = [];
  // number + magnitude/duration/percent unit, directly adjacent (optional single space)
  const reA = new RegExp(`(${NUMRAW})\\s?(?:k|mil|M|KB|MB|GB|ms|min|h|%)(?![A-Za-zÀ-ÿ])`, 'g');
  for (const m of text.matchAll(reA)) out.push({ text: m[0].trim(), value: parseBrNumber(m[1]) });
  // rate units fused to the noun they describe ("avisos/s", "requisições/dia") — the
  // word in between is why these can't share reA's "directly adjacent" pattern
  const reB = new RegExp(`(${NUMRAW})\\s+[A-Za-zÀ-ÿ]+(?:\\/s|\\/dia)`, 'g');
  for (const m of text.matchAll(reB)) out.push({ text: m[0].trim(), value: parseBrNumber(m[1]) });
  // currency prefix
  const reC = new RegExp(`(?:R\\$|US\\$|\\$)\\s?(${NUMRAW})`, 'g');
  for (const m of text.matchAll(reC)) out.push({ text: m[0].trim(), value: parseBrNumber(m[1]) });
  return out;
}

// Single source of truth for what `--lint` checks: id, what it requires, what it
// reports. `node tools/check.mjs --regras` prints this list; every lint message
// starts with the matching [id] (enforced below — an id used but not registered
// here is a programming error, not something to fail silently on).
const REGRAS = [
  { id: 'subgraphs', output: 'FALHA', requires: 'diagram.mmd groups nodes into at least 2 subgraphs' },
  { id: 'cobertura', output: 'FALHA', requires: 'every non-actor diagram node has a scorecard.components entry (ficha); every non-actor, non-external (🔌) node also has a scorecard.costs.items entry' },
  { id: 'fila', output: 'FALHA', requires: 'every queue/topic node (diagram + its ficha) declares a DLQ+reprocessing path, or an explicit accepted loss' },
  { id: 'fluxo-inicio', output: 'FALHA', requires: 'the "1·" numbered edge starts at an actor (the clients subgraph)' },
  { id: 'direcao', output: 'aviso', requires: 'no numbered edge whose label starts with an HTTP status code or resposta/devolve/retorna (a response drawn as the initiative)' },
  { id: 'emoji', output: 'aviso', requires: 'every diagram node label includes one of the taxonomy emoji' },
  { id: 'zoom', output: 'aviso', requires: 'node labels ≤ 3 lines and the diagram ≤ ~15 nodes' },
  { id: 'telemetria', output: 'aviso', requires: 'no node that looks like a generic telemetry/observability collector' },
  { id: 'atores', output: 'aviso', requires: 'at least one actor besides the end user' },
  { id: 'jargao', output: 'FALHA', requires: 'no internal-mechanics jargon (commands, skills, work rituals) in any session .md, unless scoped-exempted in meta.json jargao_permitido with a non-empty reason' },
  { id: 'etapa-aposentada', output: 'aviso', requires: 'no file on disk named after a stage retired from the canonical pipeline (tools/pipeline.mjs RETIRED_STAGES)' },
  { id: 'defesa', output: 'aviso', requires: 'every trade-off entry in 40-tradeoffs.md has a "Defesa em 30s" line' },
  { id: 'numeracao', output: 'aviso', requires: '40-tradeoffs.md "## N." headings are numbered sequentially from 1' },
  { id: 'adiadas', output: 'aviso', requires: 'no "Decisões adiadas" line in 40-tradeoffs.md promising something a stage already delivers' },
  { id: 'guardrails-soma', output: 'FALHA', requires: 'scorecard.guardrails pass+falha+na+premissas+riscos equals the item count in guardrails.md' },
  { id: 'capacity', output: 'aviso', requires: 'every scorecard.capacity number (magnitude-normalized: 2.000 ≈ 2 mil ≈ 2000 ≈ 2k) appears in 20-estimativas.md' },
  {
    id: 'numeros',
    output: 'aviso',
    requires:
      'every number-with-unit (k, mil, M, KB, MB, GB, ms, s, min, h, %, /s, /dia, currency) in 40-tradeoffs.md, 25-dominio.md, 30-design.md, and components[].purpose/scaling/failure appears in 20-estimativas.md or 10-requisitos.md',
  },
  { id: 'dominio-invariantes', output: 'FALHA', requires: '25-dominio.md invariants table: header starting "| ID |", INV-n ids, no empty cells, fixed Prevenção vocabulary' },
  { id: 'dominio-ciclo-vida', output: 'FALHA', requires: '25-dominio.md "## Ciclo de vida" stateDiagram-v2: every destination state has an outgoing edge or terminates at [*]; matches 35-modelo-de-dados.md\'s ER state enum' },
  { id: 'dominio-agregados', output: 'FALHA/aviso', requires: 'each "### Agregado: <name>" mentions cardinality (FALHA if not) and cites an INV-n or says the boundary is justified (aviso if neither)' },
  { id: 'dominio-vocabulario', output: 'FALHA', requires: 'every "## Contextos" entry owns a vocabulary term; every vocabulary owner is a declared context' },
  { id: 'dominio-modelo-vocabulario', output: 'FALHA', requires: "35-modelo-de-dados.md's vocabulary terms match 25-dominio.md's" },
  {
    id: 'dag-prosa',
    output: 'FALHA',
    requires:
      "CLAUDE.md's DAG prose line matches the canonical order in tools/pipeline.mjs ORDER (repo-wide: runs without a slug and inside --lint, never inside --hook)",
  },
];
const REGRAS_IDS = new Set(REGRAS.map((r) => r.id));

// Emit helpers shared by every predicate below: validate the id is registered
// (throwing is the point — an unregistered id must break loudly, in CI/dev, not
// pass silently in someone's session) and prefix every message with [id].
function makeEmitters(falhas, avisos, naoChecados) {
  const assertRegistered = (id) => {
    if (!REGRAS_IDS.has(id))
      throw new Error(`internal error: lint id "${id}" is not registered in REGRAS — run --regras to see the registered ids`);
  };
  return {
    falha: (id, msg) => {
      assertRegistered(id);
      falhas.push(`[${id}] ${msg}`);
    },
    aviso: (id, msg) => {
      assertRegistered(id);
      avisos.push(`[${id}] ${msg}`);
    },
    naoChecado: (id, msg) => {
      assertRegistered(id);
      naoChecados.push(`[${id}] ${msg}`);
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
  const falhas = [];
  const avisos = [];
  const naoChecados = [];
  const { falha, aviso, naoChecado } = makeEmitters(falhas, avisos, naoChecados);
  let sc = null;
  try {
    sc = JSON.parse(read('scorecard.json'));
  } catch {}
  const comps = sc?.components ?? [];
  const costs = sc?.costs?.items ?? [];
  const diagram = read('diagram.mmd');

  if (diagram) {
    const { nodes, edges, subgraphs } = parseDiagram(diagram);
    if (subgraphs.length < 2) falha('subgraphs', 'diagram has no groupings (subgraphs) — illegible');
    const isActor = (n) => /cliente/i.test(n.subgraph ?? '') || n.label.includes('👤');
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
      if (!hasComp(n)) falha('cobertura', `node "${n.id}" has no entry in the scorecard's components (legend)`);
      // external (🔌) dependencies get a ficha but never a cost line — it's someone else's infrastructure
      if (!isExternal(n) && !hasCost(n)) falha('cobertura', `node "${n.id}" has no entry in the scorecard's costs.items`);
      if (n.lines > 3) aviso('zoom', `node "${n.id}" has a ${n.lines}-line label (budget: 3 — detail belongs in the sheet)`);
      if (!TAXONOMY.some((e) => n.label.includes(e))) noEmoji.push(n.id);
      // queue = shape [[...]] or a label that STARTS by naming a queue ("queue page" doesn't count)
      const isQueue = n.shape === '[[' || /^"?\s*(fila|queue|t[óo]pico|stream)\b/i.test(n.label);
      if (isQueue) {
        const ficha = comps.find((c) => matches(n.label, c.name));
        const texto = `${n.label} ${ficha?.purpose ?? ''} ${ficha?.failure ?? ''}`;
        if (!/DLQ|perda aceita|descarte|dead.?letter/i.test(texto))
          falha('fila', `queue "${n.id}" has no declared failure destination (DLQ + reprocessing, or "accepted loss")`);
      }
    }
    if (noEmoji.length) aviso('emoji', `${noEmoji.length} node(s) without a taxonomy emoji: ${noEmoji.join(', ')}`);
    for (const n of nodes)
      if (/observabilidad|telemetria|monitor(amento|ing)\b/i.test(n.label))
        aviso(
          'telemetria',
          `node "${n.id}" looks like telemetry collection — universal collection isn't drawn (signals live in operations); keep it only if it's a component of the problem itself`
        );
    if (nodes.length > 15)
      aviso('zoom', `diagram with ${nodes.length} nodes (budget: ~15 — consider a system-node + a zoom sub-diagram)`);
    const numbered = edges.filter((e) => /^"?\s*\d+\s*[·.]/.test(e.label));
    if (!numbered.length) falha('fluxo-inicio', 'no numbered edge — the main flow must tell the story (1·, 2·…)');
    else {
      const first = numbered.find((e) => /^"?\s*1\s*[·.]/.test(e.label));
      const fromNode = first && nodes.find((n) => n.id === first.from);
      if (first && fromNode && !isActor(fromNode))
        falha('fluxo-inicio', `edge 1· starts from "${first.from}" — the flow must start at the user's arrival (clients subgraph)`);
    }
    // direction = who initiates: a numbered edge whose label opens with a response
    // (HTTP status, or resposta/devolve/retorna) is drawn backwards
    for (const e of edges) {
      const m = e.label.match(/^"?\s*\d+\s*[·.]\s*(.*)$/);
      if (m && /^(?:\d{3}\b|resposta|devolve|retorna)/i.test(m[1]))
        aviso(
          'direcao',
          `edge ${e.from}->${e.to} — label "${e.label}" opens with a response (HTTP status or resposta/devolve/retorna) though it's drawn as the numbered initiative; direction should follow who initiates the action, not who answers`
        );
    }
    const actors = nodes.filter(isActor);
    if (actors.length === 1) aviso('atores', 'no actor besides the end user (organizer/back office/ops — almost every system has one)');
  } else {
    falha('subgraphs', 'diagram.mmd missing');
  }

  // HTML comments (e.g. a stage template's lint-contract header) are documentation,
  // never artifact content — strip them before any content check, jargon included.
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {}
  const jargaoPermitido = meta?.jargao_permitido && typeof meta.jargao_permitido === 'object' ? meta.jargao_permitido : {};
  for (const f of ORDER.filter((n) => n.endsWith('.md'))) {
    const c = read(f);
    if (!c) continue;
    for (const [i, line] of stripHtmlComments(c).split('\n').entries()) {
      const m = JARGON.exec(line);
      if (!m) continue;
      const token = m[0];
      // scoped exception: meta.json declares the term is the design's own subject, with a reason
      const exemptKey = Object.keys(jargaoPermitido).find(
        (k) => token.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(token.toLowerCase())
      );
      if (exemptKey) {
        const motivo = String(jargaoPermitido[exemptKey] ?? '').trim();
        if (motivo) continue; // valid exception, scoped with a reason — not a finding
        falha(
          'jargao',
          `internal jargon in ${f}:${i + 1} ("${token}") — meta.json's jargao_permitido["${exemptKey}"] has no reason recorded, exception invalid`
        );
        continue;
      }
      falha('jargao', `internal jargon in ${f}:${i + 1} ("${token}") — artifacts are shareable`);
    }
  }

  // retired stages: a file on disk with a name that left the pipeline
  for (const f of RETIRED_STAGES)
    if (fs.existsSync(path.join(dir, f)))
      aviso('etapa-aposentada', `${f} exists on disk but is no longer part of the pipeline — hidden from both panels; safe to delete`);

  const tradeoffsRaw = read('40-tradeoffs.md');
  const tradeoffs = tradeoffsRaw ? stripHtmlComments(tradeoffsRaw) : null;
  if (tradeoffs) {
    const entries = (tradeoffs.match(/^##\s+(?!Decisões adiadas|Referências de mercado)/gm) ?? []).length;
    const defesas = (tradeoffs.match(/Defesa em 30s/g) ?? []).length;
    if (entries > defesas) aviso('defesa', `${entries - defesas} trade-off(s) in 40-tradeoffs.md without "Defesa em 30s"`);

    const entryNums = [...tradeoffs.matchAll(/^##\s+(\d+)\.\s+.+$/gm)].map((m) => Number(m[1]));
    for (let i = 0; i < entryNums.length; i++) {
      if (entryNums[i] !== i + 1) {
        aviso('numeracao', `40-tradeoffs.md — trade-off headings are numbered ${entryNums.join(', ')}, not sequential from 1`);
        break;
      }
    }

    // a "Decisões adiadas" line promising something a stage already delivers
    const adiadasSection = extractSection(tradeoffs, 'Decisões adiadas') ?? '';
    const ADIADAS_KEYWORDS = [
      { re: /dom[ií]nio/i, file: '25-dominio.md' },
      { re: /modelo(?:\s+de\s+dados)?|modelagem/i, file: '35-modelo-de-dados.md' },
      { re: /\bpoc\b|\bmvp\b/i, file: '70-poc.md' },
      { re: /d[uú]vidas|faq/i, file: '90-duvidas.md' },
    ];
    for (const rawLine of adiadasSection.split('\n')) {
      const line = rawLine.trim();
      if (!/^-\s/.test(line)) continue;
      for (const kw of ADIADAS_KEYWORDS) {
        if (!kw.re.test(line)) continue;
        let delivered = false;
        try {
          delivered = fs.readFileSync(path.join(dir, kw.file), 'utf8') !== TEMPLATE_BY_FILE[kw.file];
        } catch {}
        if (delivered) aviso('adiadas', `40-tradeoffs.md — "${line}" is listed under Decisões adiadas, but ${kw.file} already has content`);
      }
    }
  }

  // --- Domain & Modeling deterministic predicates (judge guardrails items 30-34) ---
  {
    const dominioRaw = read('25-dominio.md');
    const modeloRaw = read('35-modelo-de-dados.md');
    const dominio = dominioRaw ? stripHtmlComments(dominioRaw) : null;
    const modelo = modeloRaw ? stripHtmlComments(modeloRaw) : null;
    const PREVENCAO = ['prevenido no banco', 'prevenido no código', 'detectado depois', 'só coberto por teste'];
    const isPremissa = (s) => /premissa-a-validar/i.test(s ?? '');

    // [dominio-invariantes]
    if (!dominio) {
      naoChecado('dominio-invariantes', 'no 25-dominio.md in this session');
    } else {
      const table = findTable(dominio, '| ID |');
      if (!table) naoChecado('dominio-invariantes', 'no invariants table (header starting with "| ID |") in 25-dominio.md');
      else
        table.rows.forEach((row, ri) => {
          const id = row[0] ?? '';
          if (row.some((c) => !c)) {
            falha('dominio-invariantes', `25-dominio.md — invariant row ${ri + 1} (${id || '?'}) has an empty cell`);
            return;
          }
          if (!/^INV-\d+$/.test(id)) falha('dominio-invariantes', `25-dominio.md — invariant id "${id}" doesn't match INV-n`);
          const prevencao = row[2] ?? '';
          if (!isPremissa(prevencao) && !PREVENCAO.some((p) => normVoc(prevencao) === normVoc(p)))
            falha('dominio-invariantes', `25-dominio.md — "${id}" has "Prevenção" outside the fixed vocabulary: "${prevencao}"`);
        });
    }

    // [dominio-ciclo-vida]
    if (!dominio) {
      naoChecado('dominio-ciclo-vida', 'no 25-dominio.md in this session');
    } else {
      const section = extractSection(dominio, 'Ciclo de vida');
      const mermaidSrc = section && extractMermaid(section);
      if (!mermaidSrc || !/stateDiagram-v2/.test(mermaidSrc)) {
        naoChecado('dominio-ciclo-vida', 'no "## Ciclo de vida" section with a stateDiagram-v2 block in 25-dominio.md');
      } else {
        const edges = parseStateDiagram(mermaidSrc);
        const sources = new Set(edges.map((e) => e.from));
        const destinations = new Set(edges.map((e) => e.to).filter((t) => t !== '[*]'));
        for (const state of destinations)
          if (!sources.has(state))
            falha(
              'dominio-ciclo-vida',
              `25-dominio.md — state "${state}" is a transition's destination with no outgoing edge and no [*] termination`
            );
        // cross-file: state enum values declared on the Model's erDiagram must all exist here
        if (modelo) {
          const lifecycleStates = new Set([...sources, ...destinations].map(normVoc));
          const modeloEr = extractMermaid(modelo) ?? '';
          for (const m of modeloEr.matchAll(/\bstate\b[^\n"]*"([^"]+)"/gi))
            for (const v of m[1].split('|').map((x) => x.trim()).filter(Boolean))
              if (!lifecycleStates.has(normVoc(v)))
                falha(
                  'dominio-ciclo-vida',
                  `35-modelo-de-dados.md declares state "${v}" that doesn't exist in 25-dominio.md's lifecycle`
                );
        }
      }
    }

    // [dominio-agregados]
    if (!dominio) {
      naoChecado('dominio-agregados', 'no 25-dominio.md in this session');
    } else {
      const matches = [...dominio.matchAll(/^###\s+Agregado:\s*(.+)$/gm)];
      if (!matches.length) {
        naoChecado('dominio-agregados', 'no "### Agregado: <name>" heading in 25-dominio.md');
      } else {
        matches.forEach((m, i) => {
          const name = m[1].trim();
          const start = m.index + m[0].length;
          const end = i + 1 < matches.length ? matches[i + 1].index : dominio.length;
          const body = dominio.slice(start, end);
          if (!/cardinalidade/i.test(body)) falha('dominio-agregados', `25-dominio.md — "Agregado: ${name}" doesn't mention cardinality`);
          if (!/INV-\d+/.test(body) && !/justificad/i.test(body))
            aviso('dominio-agregados', `25-dominio.md — "Agregado: ${name}" cites no INV-n and doesn't say the boundary is justified`);
        });
      }
    }

    // [dominio-vocabulario]
    if (!dominio) {
      naoChecado('dominio-vocabulario', 'no 25-dominio.md in this session');
    } else {
      const ctxSection = extractSection(dominio, 'Contextos');
      const declaredContexts = ctxSection
        ? [...ctxSection.matchAll(/^-\s*(.+)$/gm)].map((m) => m[1].split(/[—:-]/)[0].trim()).filter(Boolean)
        : [];
      const vocabTable = findTable(dominio, '| Termo |');
      if (!declaredContexts.length || !vocabTable) {
        naoChecado('dominio-vocabulario', 'no "## Contextos" list or no vocabulary table in 25-dominio.md');
      } else {
        const ownersWithTerms = new Set();
        for (const row of vocabTable.rows) {
          const owner = row[1] ?? '';
          ownersWithTerms.add(normVoc(owner));
          if (!declaredContexts.some((c) => normVoc(c) === normVoc(owner)))
            falha('dominio-vocabulario', `25-dominio.md — vocabulary owner "${owner}" is not a declared context`);
        }
        for (const c of declaredContexts)
          if (!ownersWithTerms.has(normVoc(c)))
            falha('dominio-vocabulario', `25-dominio.md — context "${c}" has no term in the vocabulary table`);
      }
    }

    // [dominio-modelo-vocabulario] — the Model's vocabulary must match the Domain's
    if (!dominio || !modelo) {
      naoChecado('dominio-modelo-vocabulario', 'needs both 25-dominio.md and 35-modelo-de-dados.md');
    } else {
      const domVocab = findTable(dominio, '| Termo |');
      const modVocab = findTable(modelo, '| Termo |');
      if (!domVocab || !modVocab) {
        naoChecado('dominio-modelo-vocabulario', 'vocabulary table missing in one of the two files');
      } else {
        const domTerms = new Set(domVocab.rows.map((r) => normVoc(r[0])));
        for (const row of modVocab.rows) {
          const term = row[0] ?? '';
          if (term && !domTerms.has(normVoc(term)))
            falha('dominio-modelo-vocabulario', `35-modelo-de-dados.md — term "${term}" doesn't match 25-dominio.md's vocabulary`);
        }
      }
    }
  }

  // --- [capacity] and [numeros]: catch a stale number left behind after a premise
  // change propagated through some files but not all (see CLAUDE.md's propagation
  // protocol) ---
  {
    const estimativasRaw = read('20-estimativas.md');
    const requisitosRaw = read('10-requisitos.md');
    const backingNums = extractMagnitudeNumbers(
      `${estimativasRaw ? stripHtmlComments(estimativasRaw) : ''}\n${requisitosRaw ? stripHtmlComments(requisitosRaw) : ''}`
    );

    // [capacity]
    const capacity = sc?.capacity ?? [];
    if (!capacity.length) {
      naoChecado('capacity', 'no scorecard.capacity items');
    } else if (!estimativasRaw) {
      naoChecado('capacity', 'no 20-estimativas.md in this session to check numbers against');
    } else {
      for (const item of capacity) {
        const itemNums = [...extractMagnitudeNumbers(String(item.value ?? ''))];
        if (!itemNums.length) continue; // nothing numeric in this item (a qualitative value)
        const found = itemNums.some((n) => [...backingNums].some((e) => numbersClose(e, n)));
        if (!found)
          aviso(
            'capacity',
            `scorecard.capacity "${item.name}" = "${item.value}" doesn't appear in 20-estimativas.md (stale number after a premise change?)`
          );
      }
    }

    // [numeros]
    if (!estimativasRaw && !requisitosRaw) {
      naoChecado('numeros', 'no 20-estimativas.md or 10-requisitos.md in this session to check numbers against');
    } else {
      const numerosSources = [
        ['40-tradeoffs.md', tradeoffs],
        ['25-dominio.md', read('25-dominio.md')],
        ['30-design.md', read('30-design.md')],
      ];
      for (const [fname, raw] of numerosSources) {
        if (!raw) continue;
        const lines = stripHtmlComments(raw).split('\n');
        lines.forEach((line, i) => {
          for (const tok of extractNumUnitTokens(line)) {
            if (![...backingNums].some((n) => numbersClose(n, tok.value)))
              aviso(
                'numeros',
                `${fname}:${i + 1} — "${tok.text}" doesn't appear in 20-estimativas.md nor 10-requisitos.md (stale number after propagation?)`
              );
          }
        });
      }
      for (const c of comps)
        for (const field of ['purpose', 'scaling', 'failure'])
          for (const tok of extractNumUnitTokens(c[field] ?? ''))
            if (![...backingNums].some((n) => numbersClose(n, tok.value)))
              aviso(
                'numeros',
                `scorecard.components["${c.name}"].${field} — "${tok.text}" doesn't appear in 20-estimativas.md nor 10-requisitos.md (stale number after propagation?)`
              );
    }
  }

  // guardrails closed sum: pass+falha+na+premissas+riscos must equal the checklist size in
  // guardrails.md — an item nobody has judged yet can't silently disappear from the count.
  {
    let guardrailsMd = '';
    try {
      guardrailsMd = fs.readFileSync(path.join(ROOT, 'guardrails.md'), 'utf8');
    } catch {}
    const totalItems = (guardrailsMd.match(/^\d+\.\s/gm) ?? []).length;
    const g = sc?.guardrails;
    if (!totalItems) {
      naoChecado('guardrails-soma', 'root guardrails.md unreadable');
    } else if (!g) {
      naoChecado('guardrails-soma', 'no guardrails block in scorecard.json yet');
    } else {
      const { pass = 0, falha: fa = 0, na = 0, premissas = 0, riscos = 0 } = g;
      const sum = pass + fa + na + premissas + riscos;
      if (sum !== totalItems)
        falha(
          'guardrails-soma',
          `sum is ${sum} (${pass} pass + ${fa} falha + ${na} n/a + ${premissas} premissa(s) + ${riscos} risco(s)), expected ${totalItems} — guardrails.md has ${totalItems} items`
        );
    }
  }

  // repo-wide: CLAUDE.md's DAG prose vs. tools/pipeline.mjs ORDER — runs inside --lint too (never inside --hook)
  for (const p of dagProseProblems()) falha('dag-prosa', p);

  for (const f of falhas) console.log(`FALHA: ${f}`);
  for (const a of avisos) console.log(`aviso: ${a}`);
  for (const n of naoChecados) console.log(`not checked: ${n}`);
  console.log(`\nlint: ${falhas.length} falha(s) · ${avisos.length} aviso(s) · ${naoChecados.length} not checked`);
  return falhas.length === 0;
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

if (args.includes('--regras')) {
  const idWidth = Math.max(...REGRAS.map((r) => r.id.length + 2));
  for (const r of REGRAS) console.log(`${`[${r.id}]`.padEnd(idWidth)} ${r.output.padEnd(11)} — ${r.requires}`);
  process.exit(0);
}

if (doBaseline) {
  if (!slugArg) {
    console.error('usage: node tools/check.mjs <slug> --baseline [--force] [--nota "<text>"]');
    process.exit(1);
  }
  const notaIdx = args.indexOf('--nota');
  const nota = notaIdx >= 0 ? args[notaIdx + 1] : null;
  if (notaIdx >= 0 && !nota) {
    console.error('--nota with no value');
    process.exit(1);
  }
  baseline(slugArg, args.includes('--force'), nota);
  process.exit(0);
}

if (doLint) {
  if (!slugArg) {
    console.error('usage: node tools/check.mjs <slug> --lint');
    process.exit(1);
  }
  // --lint is a gate: FALHA exits != 0 so it can be used as a gate, like hook mode
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
if (!hookMode && !slugArg) for (const p of dagProseProblems()) report.push(`[dag-prosa] ${p}`);

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
  const last = readNotas(resolveDir(slugArg)).at(-1);
  if (last) console.log(`note (${last.quando.slice(0, 10)}): ${last.texto}`);
}

if (!report.length) {
  console.log(`ok — ${slugs.length} session(s) consistent`);
} else {
  console.log(report.map((r) => `✗ ${r}`).join('\n'));
  process.exit(1);
}
