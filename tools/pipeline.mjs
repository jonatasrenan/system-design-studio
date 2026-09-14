// Shared model of a session's pipeline (used by the checker and the viewer).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TEMPLATE_BY_FILE } from './templates.mjs';

// pipeline order: a change at i invalidates any untouched j > i.
// This is also the tab order in the viewer.
export const ORDER = [
  '00-problem.md',
  '10-requirements.md',
  '20-estimates.md',
  '25-domain.md',
  '30-design.md',
  '35-data-model.md',
  '40-tradeoffs.md',
  '50-operations.md',
  'diagram.mmd',
  'scorecard.json',
  '90-faq.md',
  '45-review.md',
  '70-poc.md',
];

// Stages retired from the canonical pipeline. A file on disk with one of these names
// (an old clone, a stray manual write) is hidden from both the local panel and the
// shared page by this single constant, and flagged by check.mjs --lint ([etapa-aposentada])
// instead of silently rendering as a raw filename tab. 60-avaliacao.md is here because
// the studio stopped scoring sessions on a fixed 1-4 scale — see the product-scope issue.
export const RETIRED_STAGES = ['60-avaliacao.md'];

// optional stages: absence never fails the check (not even in a completed session).
// 25-dominio.md and 35-modelo-de-dados.md sit in causal DAG position (aggregate
// boundary decides transaction boundary, transaction boundary decides row grain)
// but are only proposed by default when the dominant risk of the session is
// data-shaped — see the design skill.
export const OPTIONAL = ['25-domain.md', '35-data-model.md', '70-poc.md', '90-faq.md'];

export const hashFile = (p) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

// Strips HTML comments from markdown text before it's parsed as artifact content —
// a comment (e.g. a stage template's lint-contract header) is documentation for
// whoever edits the file, not part of the design doc. Keeps line numbers stable:
// characters inside a comment are blanked out, not removed, so a line that was
// entirely a comment becomes an empty line rather than vanishing.
export function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

// Internal jargon that must not leak into shareable artifacts (see CLAUDE.md).
// "baseline" alone is a legitimate technical term — only command forms and internal names count.
// Bilingual on purpose: sessions are written in English by default, but the
// existing ones are in Portuguese — the conversational/process voice has to be
// caught in both languages, never only in the one the studio happens to default to.
export const JARGON =
  /\/(design|review|mesa|harness-eval)\b|\bharness\b|\bchecker\b|--baseline|(check|eval|share|stage|new-session|scorecard|migrate)\.mjs|scorecard\.json|learnings\.md|patterns\.md|SKILL\.md|\b(primeira|segunda|pr[óo]xima|1ª|2ª) passada\b|\bpassada (1|2|leve|preliminar|de refer[êe]ncia)\b|me corrija|nest[ae] revis[ãa]o|revis[ãa]o preliminar|fica(m)? para o polimento|\b(first|second|next) pass\b|\bpass (1|2|light|preliminary|reference)\b|correct me if|in this review|preliminary review|left for (the )?polish/i;

// Lightweight parser for diagram.mmd (flowchart): nodes with label/shape/subgraph, and edges.
// Covers the shapes used in this repo: id["x"] id[(x)] id[[x]] id((x)) id{x} id(x) id[x].
export function parseDiagram(src) {
  const nodes = new Map(); // id -> {id, label, shape, subgraph, lines}
  const edges = [];
  const subgraphs = [];
  let current = null;
  const NODE_RE = /([A-Za-z0-9_]+)\s*(\[\[|\[\(|\(\(|\{|\[|\()\s*"?([^"\]\)\}]*)/;
  const EDGE_RE = /^\s*([A-Za-z0-9_]+)\s*(-{1,3}\.?-*>{1,2}|==+>|--+>|-\.+->)\s*(?:\|\s*"?([^|]*?)"?\s*\|\s*)?([A-Za-z0-9_]+)/;
  for (const raw of (src ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    const sg = line.match(/^subgraph\s+([A-Za-z0-9_]+)\s*(?:\[\s*"?([^"\]]*)"?\s*\])?/);
    if (sg) {
      current = { id: sg[1], title: (sg[2] ?? sg[1]).trim() };
      subgraphs.push(current);
      continue;
    }
    if (line === 'end') {
      current = null;
      continue;
    }
    const e = line.match(EDGE_RE);
    if (e) {
      edges.push({ from: e[1], to: e[4], label: (e[3] ?? '').trim(), dashed: e[2].includes('.') });
      continue;
    }
    const n = line.match(NODE_RE);
    if (n && !/^(flowchart|graph|classDef|class|style|linkStyle)$/.test(n[1])) {
      if (!nodes.has(n[1]))
        nodes.set(n[1], {
          id: n[1],
          label: n[3].trim(),
          shape: n[2],
          subgraph: current ? current.title : null,
          lines: n[3].split('\\n').length,
        });
    }
  }
  return { nodes: [...nodes.values()], edges, subgraphs };
}

// Status of each stage relative to the last baseline (.state.json):
//   ok            — exists and hasn't diverged; no upstream has diverged either
//   editado       — diverged from the baseline (work in progress)
//   desatualizado — untouched, but some upstream diverged
//   pendente      — doesn't exist yet
// Without a baseline, only ok/pendente exist (consistency isn't tracked yet).
export function stageStatus(dir) {
  let base = null;
  try {
    base = JSON.parse(fs.readFileSync(path.join(dir, '.state.json'), 'utf8')).hashes ?? {};
  } catch {}
  const stages = [];
  let upstreamChanged = false;
  // CONTENT state of the review: open FAILs in the guardrails turn the stage red
  let openFails = 0;
  try {
    openFails = JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8'))?.guardrails?.fail ?? 0;
  } catch {}
  for (const name of ORDER) {
    const p = path.join(dir, name);
    const exists = fs.existsSync(p);
    // stub: the file is still the untouched template (orange tab in the viewer)
    let stub = false;
    if (exists && TEMPLATE_BY_FILE[name]) {
      try {
        stub = fs.readFileSync(p, 'utf8') === TEMPLATE_BY_FILE[name];
      } catch {}
    }
    // scorecard: born with a skeleton from new-session — semantically empty counts
    // as "pendente" (tab off), not as an existing stage
    let scEmpty = false;
    if (exists && name === 'scorecard.json') {
      try {
        const sc = JSON.parse(fs.readFileSync(p, 'utf8'));
        const empty = (a) => !Array.isArray(a) || a.length === 0;
        scEmpty =
          empty(sc.slos) && empty(sc.capacity) && empty(sc.components) &&
          empty(sc.costs?.items) && !sc.guardrails && empty(sc.risks);
      } catch {}
    }
    let status;
    if (base === null) {
      status = exists ? 'ok' : 'pendente';
    } else {
      const tracked = name in base;
      if (!exists && !tracked) {
        status = 'pendente';
      } else {
        const cur = exists ? hashFile(p) : null;
        const changed = cur !== (base[name] ?? null);
        if (changed) {
          status = 'editado';
          upstreamChanged = true;
        } else {
          status = upstreamChanged ? 'desatualizado' : 'ok';
        }
      }
    }
    if (scEmpty) {
      status = 'pendente';
      stub = false;
    }
    // review only "closes" (green) once every item is PASS/N-A; staleness (desatualizado) takes priority
    if (name === '45-review.md' && exists && openFails > 0 && status !== 'desatualizado') {
      status = 'falhas';
      stub = false;
    }
    stages.push({ name, exists: exists && !scEmpty, status, stub });
  }
  return { baseline: base !== null, stages };
}

// User memory (learnings/padrões) is personal and stays out of version control:
// the repository versions only the `.template.md` files. Create on first need.
export function ensureMemoryFiles(root) {
  for (const name of ['learnings.md', 'patterns.md']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) continue;
    const tpl = path.join(root, name.replace(/\.md$/, '.template.md'));
    if (fs.existsSync(tpl)) fs.copyFileSync(tpl, file);
  }
}

// Root `.env`: personal configuration (bucket, distribution, AWS profile) outside
// version control. The real environment always wins over the file.
export function loadEnv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'")))
      val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// --- safe writes, shared across the tools -------------------------------------
// tmp + rename: a concurrent reader never sees the file halfway written.
export function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Per-directory lock (mkdir is atomic on the filesystem). Returns the release function;
// also releases if the process exits via process.exit() mid-operation — without
// that, an error path would leave the next write waiting 60s for the orphan.
export function lockFile(file, { timeoutMs = 15_000, staleMs = 60_000 } = {}) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) {
        console.error(`lock held for too long: ${lockDir} — is another process stuck? remove it if it's an orphan`);
        process.exit(1);
      }
      sleep(50 + Math.floor(Math.random() * 150));
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  };
  process.on('exit', release);
  return release;
}
