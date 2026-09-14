// Deterministic and COMPLETE session setup — the LLM never types out the skeleton
// nor spends extra calls on viewer/learnings.
// Usage: node tools/new-session.mjs "Design title" [--slug <slug>] [--no-viewer]
// Does in one call: creates sessions/<yyyy-mm-dd>-<slug>/ (meta.json + scorecard.json),
// makes sure the viewer is up (starts it in background if needed), and prints to stdout:
//   line 1: the slug
//   then:   viewer status, learnings with status "aberto", and padrões.
// The agent uses this output directly — no separate health curl or Reads.
//
// Parallel execution (several agents, one per session):
//   --slug <slug>   exact directory name (the orchestrator pre-assigns unique names and
//                   can export SD_SESSION=<slug> to the agent — see check.mjs --hook)
//   --no-viewer     (or SD_NO_VIEWER=1) doesn't check or start the viewer — the panel is
//                   an interactive convenience, never a dependency of the flow
//   directory creation is atomic (mkdir without recursive): two agents with the same
//   slug → exactly one wins, the other fails with "session already exists".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureMemoryFiles, loadEnv } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const title = args.find((a) => !a.startsWith('--'));
const slugArg = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
const noViewer = args.includes('--no-viewer') || process.env.SD_NO_VIEWER === '1';
if (!title) {
  console.error('usage: node tools/new-session.mjs "Design title" [--slug <slug>] [--no-viewer]');
  process.exit(1);
}
if (args.includes('--slug') && !slugArg) {
  console.error('--slug with no value');
  process.exit(1);
}
if (slugArg && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slugArg)) {
  console.error(`invalid --slug: "${slugArg}" (use only [a-z0-9-], e.g.: 2026-08-26-my-design)`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const slugify = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
const slugTitle = slugify(title);
if (!slugArg && !slugTitle) {
  console.error(`title has no letters or digits ("${title}") — can't derive a session name from it; use --slug`);
  process.exit(1);
}
const slug = slugArg ?? `${today}-${slugTitle}`;
const dir = path.join(ROOT, 'sessions', slug);
fs.mkdirSync(path.join(ROOT, 'sessions'), { recursive: true });
// mkdir WITHOUT recursive is atomic: under concurrency, only one creator gets through (EEXIST for the rest)
try {
  fs.mkdirSync(dir);
} catch (e) {
  if (e.code === 'EEXIST') {
    console.error(`session already exists: ${slug}`);
    process.exit(1);
  }
  throw e;
}

fs.writeFileSync(
  path.join(dir, 'meta.json'),
  JSON.stringify(
    // uuid: the design's permanent identity — becomes the public path if it's ever shared
    { title, status: 'em-andamento', created: today, updated: today, uuid: crypto.randomUUID() },
    null,
    2
  ) + '\n'
);

fs.writeFileSync(
  path.join(dir, 'scorecard.json'),
  JSON.stringify(
    {
      slos: [],
      capacity: [],
      components: [],
      costs: { unit: 'USD/mês', items: [] },
      guardrails: null,
      risks: [],
    },
    null,
    2
  ) + '\n'
);

// (no 00-problema.md stub: the LLM writes it in full right after —
//  a stub would only have cost a Read-before-Write)

console.log(slug);
console.log('created: meta.json, scorecard.json — 00-problema.md and the stages do NOT exist yet (Write directly, no Read)');

// --- viewer: made sure to be up, without a separate call from the agent ---
loadEnv(ROOT);
const PORT = process.env.PORT || process.env.SD_PORT || 4400;
if (noViewer) {
  console.log('viewer: skipped (--no-viewer)');
} else {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) throw new Error(String(res.status));
    console.log(`viewer: ok (http://localhost:${PORT})`);
  } catch {
    // pass the port through: without this the viewer would start on 4400 and the
    // health check would point at a different one
    const child = spawn('node', [path.join(ROOT, 'viewer', 'server.mjs')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(PORT) },
    });
    child.unref();
    console.log(`viewer: started in background (http://localhost:${PORT}) — tell the user to open it`);
  }
}

// --- open learnings + padrões: delivered here, no separate Reads ---
ensureMemoryFiles(ROOT);
const readRoot = (n) => {
  try {
    return fs.readFileSync(path.join(ROOT, n), 'utf8');
  } catch {
    return '';
  }
};
const learnings = readRoot('learnings.md').replace(/```[\s\S]*?```/g, '');
let missingStatus = 0;
const abertos = [...learnings.matchAll(/^##\s+(.+)$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/gm)]
  .filter(([, , body]) => {
    const m = body.match(/\*\*Status\*\*:\s*(\S+)/);
    if (!m) {
      missingStatus++;
      return true; // no Status line at all: safe default is OPEN, never silently dropped
    }
    return m[1] === 'aberto';
  })
  .map(([, title, body]) => {
    const como = body.match(/\*\*Como aplicar\*\*:\s*(.+)/)?.[1] ?? '';
    return `- ${title.trim()}${como ? ` — ${como.trim()}` : ''}`;
  });
// bracketed by two count lines so a caller that truncates this output (e.g. piping
// through `head`) can tell — the counts must match, or something got cut.
console.log(`\n--- ${abertos.length} learnings abertos (active alerts for this session — do not truncate this output) ---`);
console.log(abertos.length ? abertos.join('\n') : '(none)');
console.log(`--- end of ${abertos.length} learnings ---`);
if (missingStatus)
  console.error(`warning: ${missingStatus} learnings.md item(s) missing a **Status** line (normalize: add "- **Status**: aberto" or "dominado") — treated as open`);
// only the entries (`## …`), never the header nor the format block
const entriesOf = (raw) => [...raw.replace(/```[\s\S]*?```/g, '').matchAll(/^##\s[\s\S]*?(?=^##\s|\s*$(?![\s\S]))/gm)].map(([e]) => e.trim());
const padroes = entriesOf(readRoot('padroes.md'));
if (padroes.length) {
  console.log(`\n--- padrões (decisions already resolved, with the defense ready — don't re-discuss from scratch) ---`);
  console.log(padroes.join('\n\n'));
}
