// SAFE writing to the global memory files (learnings.md / patterns.md). These are
// the only shared state between sessions that the flow writes to. With several
// agents in parallel, editing by text (Read → Edit) becomes a concurrent
// read-modify-write and loses items. Here the write happens under a lock (atomic
// mkdir + retry), re-reading the file inside the critical section, with dedupe by
// title, and format validation: an item missing a required field is refused, with
// the expected format in the message, never written half-formed.
//
// Usage:
//   node tools/learnings.mjs append [--target learnings|patterns] [--session <slug>]
//       ← stdin: one or more markdown items starting with "## <title>" (the target's
//         format — see FORMAT_HELP below). An item missing a required field is
//         refused (nothing written); items whose "## <title>" already exists
//         are skipped (with a warning) — to reinforce an existing item use `note`; to
//         promote it use `promote`.
//   node tools/learnings.mjs promote "<exact title>" --session <slug>
//       changes **Status** to mastered and notes the session that proved it in **Origin**
//   node tools/learnings.mjs note "<exact title>" "<text>" [--target ...]
//       appends " · <text>" to the end of the **Origin**/**Seen in** line
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
const FILES = { learnings: 'learnings.md', patterns: 'patterns.md' };
if (!cmd || !['append', 'promote', 'note'].includes(cmd) || !FILES[target]) {
  console.error('usage: node tools/learnings.mjs append|promote|note ... [--target learnings|patterns] [--session <slug>]');
  process.exit(1);
}

// Required fields per target, and the format shown to whoever gets refused.
// Each field lists its accepted spellings: English first (what the tool writes
// and documents) and the pre-migration Portuguese one, so an item written before
// the migration keeps validating instead of being refused as malformed.
const REQUIRED_FIELDS = {
  learnings: [['Status'], ['Origin', 'Origem'], ['Learning', 'Aprendizado'], ['How to apply', 'Como aplicar']],
  patterns: [['Choice', 'Escolha'], ['When it changes', 'Quando muda'], ['30s defense', 'Defesa em 30s'], ['Seen in', 'Visto em']],
};
const FORMAT_HELP = {
  learnings: `## <short theme>
- **Status**: open | mastered
- **Origin**: sessions/<slug> (date)
- **Learning**: what became clear, in 1-3 sentences
- **How to apply**: practical trigger for next time`,
  patterns: `## <decision pattern>
- **Choice**: what was chosen
- **When it changes**: what would flip the decision
- **30s defense**: the ready articulation, with the nuance that makes the difference
- **Seen in**: sessions/<slug> (date)`,
};
// Missing fields for a block, or null if it's valid (or the target isn't validated).
function missingFields(block, tgt) {
  const required = REQUIRED_FIELDS[tgt];
  if (!required) return null;
  const fieldRe = (names) => new RegExp(`^-\\s*\\*\\*(?:${names.map((f) => f.replace(/\s/g, '\\s+')).join('|')})\\*\\*:\\s*\\S`, 'm');
  const missing = required.filter((names) => !fieldRe(names).test(block)).map((names) => names[0]);
  if (missing.length) return missing;
  if (tgt === 'learnings') {
    const m = block.match(/^-\s*\*\*Status\*\*:\s*(.+)$/m);
    if (m && !/^(open|mastered|aberto|dominado)\s*$/.test(m[1].trim())) return ['Status (must be exactly "open" or "mastered")'];
  }
  return null;
}
ensureMemoryFiles(ROOT);
const file = opt('--file') ? path.resolve(opt('--file')) : path.join(ROOT, FILES[target]);
const log = (...m) => !quiet && console.log(...m);
const today = new Date().toISOString().slice(0, 10);
const origin = session ? `sessions/${session} (${today})` : `(${today})`;

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
    const seen = new Set(); // a duplicate WITHIN the same payload is also a duplicate
    for (const it of newItems) {
      if (seen.has(norm(it.title))) {
        log(`repeated in the same submission (skipped): ${it.title}`);
        continue;
      }
      seen.add(norm(it.title));
      if (existing.has(norm(it.title))) {
        log(`already exists (skipped): ${it.title} — use note/promote to reinforce it`);
        continue;
      }
      let block = newLines.slice(it.start, it.end).join('\n').trimEnd();
      // auto-fill Origin/Seen in from --session when the block didn't bring one —
      // BEFORE validating, since that's what lets a caller omit it when --session is given
      if (session && target === 'learnings' && !/\*\*(Origin|Origem)\*\*/.test(block))
        block = block.replace(/(\*\*Status\*\*:.*)$/m, `$1\n- **Origin**: ${origin}`);
      if (session && target === 'patterns' && !/\*\*(Seen in|Visto em)\*\*/.test(block))
        block += `\n- **Seen in**: ${origin}`;
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
    // remove the empty-file placeholder (patterns.md is born with it)
    let out = md.replace(/^_\((vazio|empty)[^\n]*\)_\s*$/m, '').replace(/\s+$/, '');
    out = `${out}\n\n${blocks.join('\n\n')}\n`;
    writeAtomic(file, out);
    log(`${path.basename(file)}: ${blocks.length} item(s) appended${session ? ` (origin ${origin})` : ''}`);
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
    if (/mastered|dominado/.test(block[si])) log(`already mastered: ${it.title}`);
    block[si] = block[si].replace(/:\s*.*$/, ': mastered');
    const oi = idx(/^-\s*\*\*(Origin|Origem)\*\*:/);
    const note = `proven in ${origin}`;
    if (oi >= 0 && !block[oi].includes(note)) block[oi] = `${block[oi].trimEnd()} · ${note}`;
    log(`promoted: ${it.title} (${note})`);
  } else {
    if (!a2) {
      console.error('note: provide the text');
      process.exit(1);
    }
    const oi = idx(/^-\s*\*\*(Origin|Seen in|Origem|Visto em)\*\*:/);
    if (oi < 0) {
      console.error('item has no **Origin**/**Seen in** line');
      process.exit(1);
    }
    if (block[oi].includes(a2)) return log(`note already present: ${it.title}`);
    block[oi] = `${block[oi].trimEnd()} · ${a2}`;
    log(`noted on "${it.title}": ${a2}`);
  }
  const out = [...lines.slice(0, it.start), ...block, ...lines.slice(it.end)].join('\n');
  writeAtomic(file, out);
});
