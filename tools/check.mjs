// Consistency checker for sessions.
//
// Two kinds of checks, both deterministic:
//  - structural: valid meta.json/scorecard.json; a "concluido" session requires
//    a review to be present and guardrails with no FALHA.
//  - staleness: the pipeline is a linear DAG (problem → requirements → estimates
//    → design → trade-offs → operations → diagram/scorecard → questions → review
//    → poc → evaluation; the canonical order is ORDER, in pipeline.mjs).
//    A per-session `.state.json` stores the hashes of the last consistent state
//    (baseline). If an upstream file changed since the baseline and some downstream
//    file didn't, the downstream file is potentially stale — the agent needs to
//    revisit it (update it or confirm nothing changes) and run --baseline.
//
// Usage:
//   node tools/check.mjs                  # checks every session
//   node tools/check.mjs <slug>           # checks one session
//   node tools/check.mjs <slug> --baseline  # validates structure and marks the state as consistent
//   node tools/check.mjs <slug> --lint    # deterministic review lints (diagram, queues, jargon...)
//   node tools/check.mjs --hook           # Stop-hook mode: exit 2 blocks the turn
//
// Per-agent scoping (parallel execution): with the SD_SESSION=<slug> environment
// variable, --hook mode (and the no-slug call) checks ONLY that session — one
// agent's Stop hook is never blocked by another agent's in-progress session.
// An explicit slug on the command line still takes priority. In --hook mode,
// SD_SESSION pointing to a session that doesn't exist yet is ignored (exit 0).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER, hashFile, stageStatus, parseDiagram, JARGON, writeAtomic } from './pipeline.mjs';

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

function baseline(slug, force) {
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
  fs.writeFileSync(path.join(dir, '.state.json'), JSON.stringify({ hashes, at: new Date().toISOString() }, null, 2));
  console.log(`baseline recorded for ${slug} (${Object.keys(hashes).length} files)`);
}

// --- deterministic review lints: whatever is regex/parse stays out of the LLM and lives here ---
const TAXONOMY = ['👤', '🌐', '🧭', '⚙️', '🗄️', '⚡', '📨', '⏱️', '📊', '🛡️', '🔌'];
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
  let sc = null;
  try {
    sc = JSON.parse(read('scorecard.json'));
  } catch {}
  const comps = sc?.components ?? [];
  const costs = sc?.costs?.items ?? [];
  const diagram = read('diagram.mmd');

  if (diagram) {
    const { nodes, edges, subgraphs } = parseDiagram(diagram);
    if (subgraphs.length < 2) falhas.push('diagram has no groupings (subgraphs) — illegible');
    const isActor = (n) => /cliente/i.test(n.subgraph ?? '') || n.label.includes('👤');
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
      if (!hasComp(n)) falhas.push(`node "${n.id}" has no entry in the scorecard's components (legend)`);
      if (!hasCost(n)) falhas.push(`node "${n.id}" has no entry in the scorecard's costs.items`);
      if (n.lines > 3) avisos.push(`node "${n.id}" has a ${n.lines}-line label (budget: 3 — detail belongs in the sheet)`);
      if (!TAXONOMY.some((e) => n.label.includes(e))) noEmoji.push(n.id);
      // queue = shape [[...]] or a label that STARTS by naming a queue ("queue page" doesn't count)
      const isQueue = n.shape === '[[' || /^"?\s*(fila|queue|t[óo]pico|stream)\b/i.test(n.label);
      if (isQueue) {
        const ficha = comps.find((c) => matches(n.label, c.name));
        const texto = `${n.label} ${ficha?.purpose ?? ''} ${ficha?.failure ?? ''}`;
        if (!/DLQ|perda aceita|descarte|dead.?letter/i.test(texto))
          falhas.push(`queue "${n.id}" has no declared failure destination (DLQ + reprocessing, or "accepted loss")`);
      }
    }
    if (noEmoji.length) avisos.push(`${noEmoji.length} node(s) without a taxonomy emoji: ${noEmoji.join(', ')}`);
    for (const n of nodes)
      if (/observabilidad|telemetria|monitor(amento|ing)\b/i.test(n.label))
        avisos.push(
          `node "${n.id}" looks like telemetry collection — universal collection isn't drawn (signals live in operations); keep it only if it's a component of the problem itself`
        );
    if (nodes.length > 15) avisos.push(`diagram with ${nodes.length} nodes (budget: ~15 — consider a system-node + a zoom sub-diagram)`);
    const numbered = edges.filter((e) => /^"?\s*\d+\s*[·.]/.test(e.label));
    if (!numbered.length) falhas.push('no numbered edge — the main flow must tell the story (1·, 2·…)');
    else {
      const first = numbered.find((e) => /^"?\s*1\s*[·.]/.test(e.label));
      const fromNode = first && nodes.find((n) => n.id === first.from);
      if (first && fromNode && !isActor(fromNode))
        falhas.push(`edge 1· starts from "${first.from}" — the flow must start at the user's arrival (clients subgraph)`);
    }
    const actors = nodes.filter(isActor);
    if (actors.length === 1) avisos.push('no actor besides the end user (organizer/back office/ops — almost every system has one)');
  } else {
    falhas.push('diagram.mmd missing');
  }

  for (const f of ORDER.filter((n) => n.endsWith('.md'))) {
    const c = read(f);
    if (!c) continue;
    for (const [i, line] of c.split('\n').entries())
      if (JARGON.test(line)) falhas.push(`internal jargon in ${f}:${i + 1} — artifacts are shareable`);
  }

  const tradeoffs = read('40-tradeoffs.md');
  if (tradeoffs) {
    const entries = (tradeoffs.match(/^##\s+(?!Decisões adiadas|Referências de mercado)/gm) ?? []).length;
    const defesas = (tradeoffs.match(/Defesa em 30s/g) ?? []).length;
    if (entries > defesas) avisos.push(`${entries - defesas} trade-off(s) without "Defesa em 30s"`);
  }

  for (const f of falhas) console.log(`FALHA: ${f}`);
  for (const a of avisos) console.log(`aviso: ${a}`);
  console.log(`\nlint: ${falhas.length} falha(s) · ${avisos.length} aviso(s)`);
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

if (doBaseline) {
  if (!slugArg) {
    console.error('usage: node tools/check.mjs <slug> --baseline [--force]');
    process.exit(1);
  }
  baseline(slugArg, args.includes('--force'));
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

if (!report.length) {
  console.log(`ok — ${slugs.length} session(s) consistent`);
} else {
  console.log(report.map((r) => `✗ ${r}`).join('\n'));
  process.exit(1);
}
