// SAFE writing to the global memory files (learnings.md / padroes.md). These are
// the only shared state between sessions that the flow writes to. With several
// agents in parallel, editing by text (Read → Edit) becomes a concurrent
// read-modify-write and loses items. Here the write happens under a lock (atomic
// mkdir + retry), re-reading the file inside the critical section, with dedupe by
// title, and format validation: an item missing a required field is refused, with
// the expected format in the message, never written half-formed.
//
// Usage:
//   node tools/learnings.mjs append [--target learnings|padroes] [--session <slug>]
//       ← stdin: one or more markdown items starting with "## <title>" (the target's
//         format — see FORMAT_HELP below). An item missing a required field is
//         refused (nothing written); items whose "## <title>" already exists
//         are skipped (with a warning) — to reinforce an existing item use `note`; to
//         promote it use `promote`.
//   node tools/learnings.mjs promote "<exact title>" --session <slug>
//       changes **Status** to dominado and notes the session that proved it in **Origem**
//   node tools/learnings.mjs note "<exact title>" "<text>" [--target ...]
//       appends " · <text>" to the end of the **Origem**/**Visto em** line
//   [--file <path>] overrides the target (tests); [--quiet] only prints errors.
// Always idempotent by title; never rewrites existing items beyond the field requested.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMemoryFiles } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const flags = new Set(['--target', '--session', '--file']);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) i++;
  else if (!args[i].startsWith('--')) positional.push(args[i]);
}
const [cmd, a1, a2] = positional;
const quiet = args.includes('--quiet');
const target = opt('--target') ?? 'learnings';
const session = opt('--session');
const FILES = { learnings: 'learnings.md', padroes: 'padroes.md' };
if (!cmd || !['append', 'promote', 'note'].includes(cmd) || !FILES[target]) {
  console.error('usage: node tools/learnings.mjs append|promote|note ... [--target learnings|padroes] [--session <slug>]');
  process.exit(1);
}

// Required fields per target, and the format shown to whoever gets refused.
const REQUIRED_FIELDS = {
  learnings: ['Status', 'Origem', 'Aprendizado', 'Como aplicar'],
  padroes: ['Escolha', 'Quando muda', 'Defesa em 30s', 'Visto em'],
};
const FORMAT_HELP = {
  learnings: `## <short theme>
- **Status**: aberto | dominado
- **Origem**: sessions/<slug> (date)
- **Aprendizado**: what became clear, in 1-3 sentences
- **Como aplicar**: practical trigger for next time`,
  padroes: `## <decision pattern>
- **Escolha**: what was chosen
- **Quando muda**: what would flip the decision
- **Defesa em 30s**: the ready articulation, with the nuance that makes the difference
- **Visto em**: sessions/<slug> (date)`,
};
// Missing fields for a block, or null if it's valid (or the target isn't validated).
function missingFields(block, tgt) {
  const required = REQUIRED_FIELDS[tgt];
  if (!required) return null;
  const missing = required.filter((f) => !new RegExp(`^-\\s*\\*\\*${f.replace(/\s/g, '\\s+')}\\*\\*:\\s*\\S`, 'm').test(block));
  if (missing.length) return missing;
  if (tgt === 'learnings') {
    const m = block.match(/^-\s*\*\*Status\*\*:\s*(.+)$/m);
    if (m && !/^(aberto|dominado)\s*$/.test(m[1].trim())) return ['Status (must be exactly "aberto" or "dominado")'];
  }
  return null;
}
ensureMemoryFiles(ROOT);
const file = opt('--file') ? path.resolve(opt('--file')) : path.join(ROOT, FILES[target]);
const log = (...m) => !quiet && console.log(...m);
const today = new Date().toISOString().slice(0, 10);
const origem = session ? `sessions/${session} (${today})` : `(${today})`;

// --- lock: mkdir is atomic on the filesystem; an orphaned lock (> 60s) is removed ---
const lockDir = `${file}.lock`;
async function withLock(fn) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 60_000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) {
        console.error(`lock held for too long: ${lockDir} — is another agent stuck? remove it manually if it's an orphan`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    }
  }
  // also releases when fn() exits via process.exit() (validation failed): without this
  // the orphaned lock would make the next write wait 15s and fail.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.rmSync(lockDir, { recursive: true, force: true });
  };
  process.on('exit', release);
  try {
    return fn();
  } finally {
    release();
  }
}

// --- parsing: items = "## title" blocks outside of ``` fences ---
function splitItems(md) {
  const lines = md.split('\n');
  const items = []; // {title, start, end}
  let inFence = false;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    const h = !inFence && lines[i].match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (cur) cur.end = i;
      cur = { title: h[1], start: i, end: lines.length };
      items.push(cur);
    }
  }
  return { lines, items };
}
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// atomic write: tmp + rename (a reader never sees the file halfway written)
function writeAtomic(p, content) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

const stdin = () => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

await withLock(() => {
  const md = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { lines, items } = splitItems(md);
  const existing = new Map(items.map((it) => [norm(it.title), it]));

  if (cmd === 'append') {
    const input = stdin().trim();
    if (!input) {
      console.error('append: empty stdin — send one or more "## title" items in the file\'s format');
      process.exit(1);
    }
    const { items: newItems, lines: newLines } = splitItems(input);
    if (!newItems.length) {
      console.error('append: no "## title" found in stdin');
      process.exit(1);
    }
    const blocks = [];
    const vistos = new Set(); // a duplicate WITHIN the same payload is also a duplicate
    for (const it of newItems) {
      if (vistos.has(norm(it.title))) {
        log(`repeated in the same submission (skipped): ${it.title}`);
        continue;
      }
      vistos.add(norm(it.title));
      if (existing.has(norm(it.title))) {
        log(`already exists (skipped): ${it.title} — use note/promote to reinforce it`);
        continue;
      }
      let block = newLines.slice(it.start, it.end).join('\n').trimEnd();
      // auto-fill Origem/Visto em from --session when the block didn't bring one —
      // BEFORE validating, since that's what lets a caller omit it when --session is given
      if (session && target === 'learnings' && !/\*\*Origem\*\*/.test(block))
        block = block.replace(/(\*\*Status\*\*:.*)$/m, `$1\n- **Origem**: ${origem}`);
      if (session && target === 'padroes' && !/\*\*Visto em\*\*/.test(block))
        block += `\n- **Visto em**: ${origem}`;
      const missing = missingFields(block, target);
      if (missing) {
        console.error(
          `append: "${it.title}" is missing ${missing.join(', ')} — ${target} items must follow this format:\n\n${FORMAT_HELP[target]}`
        );
        process.exit(1); // nothing written — a batch with one malformed item writes nothing, not a partial result
      }
      blocks.push(block);
    }
    if (!blocks.length) return log('nothing to append');
    // remove the empty-file placeholder (padroes.md is born with it)
    let out = md.replace(/^_\(vazio[^\n]*\)_\s*$/m, '').replace(/\s+$/, '');
    out = `${out}\n\n${blocks.join('\n\n')}\n`;
    writeAtomic(file, out);
    log(`${path.basename(file)}: ${blocks.length} item(s) appended${session ? ` (origin ${origem})` : ''}`);
    return;
  }

  const it = a1 && existing.get(norm(a1));
  if (!it) {
    console.error(`item not found in ${path.basename(file)}: "${a1}" (titles: ${items.map((i) => i.title).join(' | ')})`);
    process.exit(1);
  }
  const block = lines.slice(it.start, it.end);
  const idx = (re) => block.findIndex((l) => re.test(l));
  if (cmd === 'promote') {
    const si = idx(/^-\s*\*\*Status\*\*:/);
    if (si < 0) {
      console.error('item has no **Status** line');
      process.exit(1);
    }
    if (/dominado/.test(block[si])) log(`already dominado: ${it.title}`);
    block[si] = block[si].replace(/:\s*.*$/, ': dominado');
    const oi = idx(/^-\s*\*\*Origem\*\*:/);
    const nota = `comprovado em ${origem}`;
    if (oi >= 0 && !block[oi].includes(nota)) block[oi] = `${block[oi].trimEnd()} · ${nota}`;
    log(`promoted: ${it.title} (${nota})`);
  } else {
    if (!a2) {
      console.error('note: provide the text');
      process.exit(1);
    }
    const oi = idx(/^-\s*\*\*(Origem|Visto em)\*\*:/);
    if (oi < 0) {
      console.error('item has no **Origem**/**Visto em** line');
      process.exit(1);
    }
    if (block[oi].includes(a2)) return log(`note already present: ${it.title}`);
    block[oi] = `${block[oi].trimEnd()} · ${a2}`;
    log(`noted on "${it.title}": ${a2}`);
  }
  const out = [...lines.slice(0, it.start), ...block, ...lines.slice(it.end)].join('\n');
  writeAtomic(file, out);
});
