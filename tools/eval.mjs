// Structural, deterministic eval of a system design session.
// Checks whether the harness produced every artifact in the expected shape —
// semantic quality is still the job of /review.
//
// Usage:
//   node tools/eval.mjs <slug|path>                 # evaluates one session
//   node tools/eval.mjs <slug|path> --golden <dir>  # compares coverage against a reference session
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER, OPTIONAL, stageStatus, parseDiagram, JARGON, stripHtmlComments } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const goldenDir = args.includes('--golden') ? args[args.indexOf('--golden') + 1] : null;
if (!target) {
  console.error('usage: node tools/eval.mjs <slug|path> [--golden <dir>]');
  process.exit(1);
}
const dir = target.includes('/') ? path.resolve(target) : path.join(ROOT, 'sessions', target);
if (!fs.existsSync(dir)) {
  console.error(`session not found: ${dir}`);
  process.exit(1);
}

const read = (n) => {
  try {
    return fs.readFileSync(path.join(dir, n), 'utf8');
  } catch {
    return null;
  }
};
const readJson = (n) => {
  try {
    return JSON.parse(read(n));
  } catch {
    return null;
  }
};

const results = []; // {level: 'ok'|'warn'|'fail', label, detail}
const add = (level, label, detail = '') => results.push({ level, label, detail });

// --- meta ---
const meta = readJson('meta.json');
if (meta?.title && meta?.status) add('ok', 'meta.json valid', meta.status);
else add('fail', 'meta.json missing/incomplete');
const done = meta?.status === 'done';

// --- stages present ---
const present = ORDER.filter((n) => fs.existsSync(path.join(dir, n)));
const missing = ORDER.filter((n) => !fs.existsSync(path.join(dir, n)) && !OPTIONAL.includes(n));
add(
  missing.length === 0 ? 'ok' : done ? 'fail' : 'warn',
  `pipeline stages: ${present.length}/${ORDER.length}`,
  missing.length ? `missing: ${missing.join(', ')}` : ''
);

// --- request story ---
const design = read('30-design.md');
if (design) {
  const firstH2 = design.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? '';
  // bilingual: the English heading is the default, the Portuguese one is what
  // sessions written before the migration use
  if (/hist[óo]ria de uma request|story of a request/i.test(firstH2)) add('ok', 'design opens with "The story of a request"');
  else add('fail', 'design does not open with "The story of a request"', `first section: "${firstH2}"`);
} else add(done ? 'fail' : 'warn', '30-design.md missing');

// --- diagram ---
const diagram = read('diagram.mmd');
const dgNodes = diagram ? parseDiagram(diagram).nodes : [];
const nodeIds = dgNodes.map((n) => n.id);
// actors (clients subgraph) don't require a sheet — same exemption as the lint
const coverNodes = dgNodes.filter((n) => !/cliente/i.test(n.subgraph ?? ''));
if (diagram && nodeIds.length >= 5 && /subgraph/.test(diagram))
  add('ok', `diagram with ${nodeIds.length} nodes and groupings`);
else if (diagram) add('warn', `shallow diagram (${nodeIds.length} nodes, subgraphs: ${/subgraph/.test(diagram)})`);
else add(done ? 'fail' : 'warn', 'diagram.mmd missing');

// --- scorecard ---
const sc = readJson('scorecard.json');
if (!sc) add(done ? 'fail' : 'warn', 'scorecard.json missing/invalid');
else {
  for (const [key, min] of [['slos', 1], ['capacity', 1], ['components', 3]]) {
    const n = sc[key]?.length ?? 0;
    add(n >= min ? 'ok' : done ? 'fail' : 'warn', `scorecard.${key}: ${n} item(s)`);
  }
  const costs = sc.costs?.items ?? [];
  const numeric = costs.every((i) => typeof i.cost === 'number');
  add(
    costs.length >= 3 && numeric ? 'ok' : done ? 'fail' : 'warn',
    `scorecard.costs: ${costs.length} component(s)${numeric ? '' : ' (non-numeric costs!)'}`
  );
  if (sc.components?.length && coverNodes.length)
    add(
      sc.components.length >= coverNodes.length ? 'ok' : 'warn',
      `legend coverage: ${sc.components.length} entries for ${coverNodes.length} coverable nodes (actors exempt)`
    );
  if (done) {
    const g = sc.guardrails;
    if (g && g.fail === 0 && g.pass > 0) add('ok', `guardrails: ${g.pass} pass · 0 fail · ${g.na} n/a`);
    else add('fail', 'completed without clean guardrails in the scorecard', JSON.stringify(g ?? null));
  }
}

// --- review as a gate ---
if (done) {
  const review = read('45-review.md');
  if (review && /\b(FAIL|FALHA)\b/i.test(review)) add('ok', '45-review.md present with a verdict per item');
  else add('fail', 'completed without a substantive 45-review.md');
}

// --- baseline and consistency ---
const { baseline, stages } = stageStatus(dir);
if (!baseline) add(done ? 'fail' : 'warn', 'no baseline (.state.json) — consistency isn\'t tracked');
else {
  const dirty = stages.filter((s) => s.status === 'editado' || s.status === 'desatualizado');
  if (dirty.length === 0) add('ok', 'baseline consistent (no dirty stage)');
  else add('fail', 'inconsistent baseline', dirty.map((s) => `${s.name}:${s.status}`).join(', '));
}

// --- internal jargon in artifacts (pages are shareable — commands/mechanics can't leak) ---
{
  // shared regex in pipeline.mjs — same ruler as check.mjs --lint
  const leaks = [];
  for (const f of ORDER.filter((n) => n.endsWith('.md'))) {
    const c = read(f);
    if (!c) continue;
    for (const [i, line] of stripHtmlComments(c).split('\n').entries()) if (JARGON.test(line)) leaks.push(`${f}:${i + 1}`);
  }
  add(leaks.length === 0 ? 'ok' : 'fail', 'artifacts free of internal jargon (shareable)', leaks.slice(0, 5).join(', '));
}

// --- defense material (informative: a count, not a verdict — doesn't fail old sessions) ---
if (sc?.components?.length) {
  const n = sc.components.length;
  const count = (k) => sc.components.filter((c) => c[k]).length;
  add('info', `components with "why": ${count('why')}/${n}`);
  add('info', `full sheet (what / if it fails / how it scales): ${count('what')}/${count('failure')}/${count('scaling')} of ${n}`);
}
const tradeoffs = read('40-tradeoffs.md');
if (tradeoffs) {
  // fixed sections (Deferred decisions, Market references) aren't trade-offs
  const entries = (tradeoffs.match(/^##\s+(?!Deferred decisions|Market references|Decisões adiadas|Referências de mercado)/gm) ?? []).length;
  const defenses = (tradeoffs.match(/30s defense|Defesa em 30s/g) ?? []).length;
  add('info', `trade-offs with a "30s defense": ${defenses}/${entries}`);
}
add(fs.existsSync(path.join(dir, '90-faq.md')) ? 'ok' : 'warn', 'anticipated FAQ (90-faq.md)', 'optional in older sessions');

// --- learnings (repo root) ---
const learnings = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'learnings.md'), 'utf8');
  } catch {
    return '';
  }
})();
const learningItems = (learnings.replace(/```[\s\S]*?```/g, '').match(/^##\s+/gm) ?? []).length;
add(
  learningItems > 0 ? 'ok' : 'warn',
  `learnings.md: ${learningItems} item(s)`,
  learningItems === 0 ? 'expected ≥1 once at least one session has been reviewed' : ''
);

// --- golden comparison ---
if (goldenDir) {
  const g = path.resolve(goldenDir);
  const gsc = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(g, 'scorecard.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  const gPresent = ORDER.filter((n) => fs.existsSync(path.join(g, n)));
  console.log('\n— comparison with golden —');
  console.log(`stages:      candidate ${present.length}/${ORDER.length} · golden ${gPresent.length}/${ORDER.length}`);
  if (gsc && sc) {
    for (const k of ['slos', 'capacity', 'components']) {
      console.log(`${k.padEnd(12)} candidate ${sc[k]?.length ?? 0} · golden ${gsc[k]?.length ?? 0}`);
    }
    console.log(`costs        candidate ${sc.costs?.items?.length ?? 0} · golden ${gsc.costs?.items?.length ?? 0}`);
    console.log(
      `guardrails   candidate ${sc.guardrails ? `${sc.guardrails.pass}p/${sc.guardrails.fail}f` : '—'} · golden ${gsc.guardrails ? `${gsc.guardrails.pass}p/${gsc.guardrails.fail}f` : '—'}`
    );
  }
}

// --- report ---
const icon = { ok: '✓', warn: '⚠', fail: '✗', info: '·' };
console.log(`\n=== eval: ${path.basename(dir)} ===`);
for (const r of results) console.log(`${icon[r.level]} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
const counts = { ok: 0, warn: 0, fail: 0, info: 0 };
for (const r of results) counts[r.level]++;
console.log(`\n${counts.ok} ok · ${counts.warn} warnings · ${counts.fail} failures`);
process.exit(counts.fail ? 1 : 0);
