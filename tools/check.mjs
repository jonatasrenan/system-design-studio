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
import { ORDER, hashFile, stageStatus, parseDiagram, JARGON, writeAtomic, stripHtmlComments } from './pipeline.mjs';

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

  // HTML comments (e.g. a stage template's lint-contract header) are documentation,
  // never artifact content — strip them before any content check, jargon included.
  for (const f of ORDER.filter((n) => n.endsWith('.md'))) {
    const c = read(f);
    if (!c) continue;
    for (const [i, line] of stripHtmlComments(c).split('\n').entries())
      if (JARGON.test(line)) falhas.push(`internal jargon in ${f}:${i + 1} — artifacts are shareable`);
  }

  const tradeoffs = read('40-tradeoffs.md');
  if (tradeoffs) {
    const entries = (tradeoffs.match(/^##\s+(?!Decisões adiadas|Referências de mercado)/gm) ?? []).length;
    const defesas = (tradeoffs.match(/Defesa em 30s/g) ?? []).length;
    if (entries > defesas) avisos.push(`${entries - defesas} trade-off(s) without "Defesa em 30s"`);
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
      naoChecados.push('dominio-invariantes — no 25-dominio.md in this session');
    } else {
      const table = findTable(dominio, '| ID |');
      if (!table) naoChecados.push('dominio-invariantes — no invariants table (header starting with "| ID |") in 25-dominio.md');
      else
        table.rows.forEach((row, ri) => {
          const id = row[0] ?? '';
          if (row.some((c) => !c)) {
            falhas.push(`dominio-invariantes: 25-dominio.md — invariant row ${ri + 1} (${id || '?'}) has an empty cell`);
            return;
          }
          if (!/^INV-\d+$/.test(id)) falhas.push(`dominio-invariantes: 25-dominio.md — invariant id "${id}" doesn't match INV-n`);
          const prevencao = row[2] ?? '';
          if (!isPremissa(prevencao) && !PREVENCAO.some((p) => normVoc(prevencao) === normVoc(p)))
            falhas.push(`dominio-invariantes: 25-dominio.md — "${id}" has "Prevenção" outside the fixed vocabulary: "${prevencao}"`);
        });
    }

    // [dominio-ciclo-vida]
    if (!dominio) {
      naoChecados.push('dominio-ciclo-vida — no 25-dominio.md in this session');
    } else {
      const section = extractSection(dominio, 'Ciclo de vida');
      const mermaidSrc = section && extractMermaid(section);
      if (!mermaidSrc || !/stateDiagram-v2/.test(mermaidSrc)) {
        naoChecados.push('dominio-ciclo-vida — no "## Ciclo de vida" section with a stateDiagram-v2 block in 25-dominio.md');
      } else {
        const edges = parseStateDiagram(mermaidSrc);
        const sources = new Set(edges.map((e) => e.from));
        const destinations = new Set(edges.map((e) => e.to).filter((t) => t !== '[*]'));
        for (const state of destinations)
          if (!sources.has(state))
            falhas.push(
              `dominio-ciclo-vida: 25-dominio.md — state "${state}" is a transition's destination with no outgoing edge and no [*] termination`
            );
        // cross-file: state enum values declared on the Model's erDiagram must all exist here
        if (modelo) {
          const lifecycleStates = new Set([...sources, ...destinations].map(normVoc));
          const modeloEr = extractMermaid(modelo) ?? '';
          for (const m of modeloEr.matchAll(/\bstate\b[^\n"]*"([^"]+)"/gi))
            for (const v of m[1].split('|').map((x) => x.trim()).filter(Boolean))
              if (!lifecycleStates.has(normVoc(v)))
                falhas.push(
                  `dominio-ciclo-vida: 35-modelo-de-dados.md declares state "${v}" that doesn't exist in 25-dominio.md's lifecycle`
                );
        }
      }
    }

    // [dominio-agregados]
    if (!dominio) {
      naoChecados.push('dominio-agregados — no 25-dominio.md in this session');
    } else {
      const matches = [...dominio.matchAll(/^###\s+Agregado:\s*(.+)$/gm)];
      if (!matches.length) {
        naoChecados.push('dominio-agregados — no "### Agregado: <name>" heading in 25-dominio.md');
      } else {
        matches.forEach((m, i) => {
          const name = m[1].trim();
          const start = m.index + m[0].length;
          const end = i + 1 < matches.length ? matches[i + 1].index : dominio.length;
          const body = dominio.slice(start, end);
          if (!/cardinalidade/i.test(body)) falhas.push(`dominio-agregados: 25-dominio.md — "Agregado: ${name}" doesn't mention cardinality`);
          if (!/INV-\d+/.test(body) && !/justificad/i.test(body))
            avisos.push(`dominio-agregados: 25-dominio.md — "Agregado: ${name}" cites no INV-n and doesn't say the boundary is justified`);
        });
      }
    }

    // [dominio-vocabulario]
    if (!dominio) {
      naoChecados.push('dominio-vocabulario — no 25-dominio.md in this session');
    } else {
      const ctxSection = extractSection(dominio, 'Contextos');
      const declaredContexts = ctxSection
        ? [...ctxSection.matchAll(/^-\s*(.+)$/gm)].map((m) => m[1].split(/[—:-]/)[0].trim()).filter(Boolean)
        : [];
      const vocabTable = findTable(dominio, '| Termo |');
      if (!declaredContexts.length || !vocabTable) {
        naoChecados.push('dominio-vocabulario — no "## Contextos" list or no vocabulary table in 25-dominio.md');
      } else {
        const ownersWithTerms = new Set();
        for (const row of vocabTable.rows) {
          const owner = row[1] ?? '';
          ownersWithTerms.add(normVoc(owner));
          if (!declaredContexts.some((c) => normVoc(c) === normVoc(owner)))
            falhas.push(`dominio-vocabulario: 25-dominio.md — vocabulary owner "${owner}" is not a declared context`);
        }
        for (const c of declaredContexts)
          if (!ownersWithTerms.has(normVoc(c)))
            falhas.push(`dominio-vocabulario: 25-dominio.md — context "${c}" has no term in the vocabulary table`);
      }
    }

    // [dominio-modelo-vocabulario] — the Model's vocabulary must match the Domain's
    if (!dominio || !modelo) {
      naoChecados.push('dominio-modelo-vocabulario — needs both 25-dominio.md and 35-modelo-de-dados.md');
    } else {
      const domVocab = findTable(dominio, '| Termo |');
      const modVocab = findTable(modelo, '| Termo |');
      if (!domVocab || !modVocab) {
        naoChecados.push('dominio-modelo-vocabulario — vocabulary table missing in one of the two files');
      } else {
        const domTerms = new Set(domVocab.rows.map((r) => normVoc(r[0])));
        for (const row of modVocab.rows) {
          const term = row[0] ?? '';
          if (term && !domTerms.has(normVoc(term)))
            falhas.push(`dominio-modelo-vocabulario: 35-modelo-de-dados.md — term "${term}" doesn't match 25-dominio.md's vocabulary`);
        }
      }
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
      naoChecados.push('guardrails closed sum — root guardrails.md unreadable');
    } else if (!g) {
      naoChecados.push('guardrails closed sum — no guardrails block in scorecard.json yet');
    } else {
      const { pass = 0, falha = 0, na = 0, premissas = 0, riscos = 0 } = g;
      const sum = pass + falha + na + premissas + riscos;
      if (sum !== totalItems)
        falhas.push(
          `guardrails sum is ${sum} (${pass} pass + ${falha} falha + ${na} n/a + ${premissas} premissa(s) + ${riscos} risco(s)), expected ${totalItems} — guardrails.md has ${totalItems} items`
        );
    }
  }

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
