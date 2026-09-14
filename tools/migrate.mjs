// One-shot, idempotent migration of a session's user-facing names to English.
//
// The studio used to name stage files, meta/scorecard keys and verdicts in
// Portuguese. Sessions created before that change still open in the viewer and
// still lint — this script brings one (or all) of them onto the current names
// without touching the design's content.
//
// Usage:
//   node tools/migrate.mjs <slug|path>        # migrates one session
//   node tools/migrate.mjs --all              # migrates every session under sessions/
//   node tools/migrate.mjs --all --dry-run    # prints what would change, writes nothing
//
// What it does, per session:
//   1. renames the stage files (00-problema.md → 00-problem.md, …);
//   2. rewrites meta.json values (mode, status) and the allowed_jargon key;
//   3. rewrites scorecard.json keys/values (guardrails, rubric, costs.unit);
//   4. rewrites the markers inside the .md files: the [premissa-a-validar] mark
//      and the review's verdict words (FALHA / RISCO ACEITO);
//   5. rewrites references to the renamed files anywhere inside the session;
//   6. re-keys .state.json to the new names AND refreshes its hashes, so the
//      migration doesn't read as a premise change that needs propagating.
//
// Idempotent: running it twice changes nothing the second time. Design content
// (prose, numbers, decisions) is never rewritten — only names and markers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, ORDER } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS_DIR = path.join(ROOT, 'sessions');

// old name -> new name. 60-avaliacao.md is NOT here: it's a retired stage, kept
// under its historical name by tools/pipeline.mjs RETIRED_STAGES.
export const FILE_RENAMES = {
  '00-problema.md': '00-problem.md',
  '10-requisitos.md': '10-requirements.md',
  '20-estimativas.md': '20-estimates.md',
  '25-dominio.md': '25-domain.md',
  '35-modelo-de-dados.md': '35-data-model.md',
  '50-operacao.md': '50-operations.md',
  '90-duvidas.md': '90-faq.md',
};

const META_VALUES = {
  mode: { estudio: 'studio' },
  status: { 'em-andamento': 'in-progress', concluido: 'done' },
};

// markers rewritten inside .md files: verdict words and the premise mark.
// Only the uppercase verdicts are touched — lowercase "falha"/"risco" in prose
// is the design's own text, never a marker.
const MD_MARKERS = [
  [/\[premissa-a-validar\]/g, '[premise-to-validate]'],
  [/\bRISCOS ACEITOS\b/g, 'ACCEPTED RISKS'],
  [/\bRISCO ACEITO\b/g, 'ACCEPTED RISK'],
  [/\bFALHAS\b/g, 'FAILS'],
  // "FALHAs" — the verdict word pluralized in running text
  [/\bFALHAs\b/g, 'FAILs'],
  [/\bFALHA\b/g, 'FAIL'],
  // the review's scoreboard line is a fixed header, not prose
  [/\*\*Placar:/g, '**Score:'],
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const target = args.find((a) => !a.startsWith('--'));
if (!all && !target) {
  console.error('usage: node tools/migrate.mjs [<slug>|--all] [--dry-run]');
  process.exit(1);
}

const changes = [];
const note = (dir, msg) => changes.push(`${path.basename(dir)}: ${msg}`);
const writeFile = (p, content) => {
  if (!dryRun) fs.writeFileSync(p, content);
};

function migrateSession(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`session not found: ${dir}`);
    process.exit(1);
  }

  // 1. stage files
  for (const [from, to] of Object.entries(FILE_RENAMES)) {
    const src = path.join(dir, from);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, to);
    if (fs.existsSync(dst)) {
      console.error(`${path.basename(dir)}: both ${from} and ${to} exist — resolve by hand, nothing renamed`);
      process.exit(1);
    }
    if (!dryRun) fs.renameSync(src, dst);
    note(dir, `${from} → ${to}`);
  }

  // 2. meta.json
  const metaPath = path.join(dir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      let touched = false;
      for (const [key, map] of Object.entries(META_VALUES)) {
        if (meta[key] && map[meta[key]]) {
          note(dir, `meta.${key}: ${meta[key]} → ${map[meta[key]]}`);
          meta[key] = map[meta[key]];
          touched = true;
        }
      }
      if (meta.jargao_permitido && !meta.allowed_jargon) {
        meta.allowed_jargon = meta.jargao_permitido;
        delete meta.jargao_permitido;
        note(dir, 'meta.jargao_permitido → meta.allowed_jargon');
        touched = true;
      }
      if (touched) writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
    } catch (e) {
      console.error(`${path.basename(dir)}: meta.json unreadable (${e.message}) — skipped`);
    }
  }

  // 3. scorecard.json
  const scPath = path.join(dir, 'scorecard.json');
  if (fs.existsSync(scPath)) {
    try {
      const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'));
      let touched = false;
      const g = sc.guardrails;
      if (g && typeof g === 'object') {
        for (const [from, to] of [
          ['falha', 'fail'],
          ['falhas', 'failures'],
          ['premissas', 'premises'],
          ['riscos', 'accepted_risks'],
        ]) {
          if (from in g) {
            g[to] = g[from];
            delete g[from];
            note(dir, `scorecard.guardrails.${from} → ${to}`);
            touched = true;
          }
        }
      }
      // rubric: leftover from the retired 1-4 scoring stage — the data stays,
      // only its field names move to English
      for (const row of sc.rubric?.scores ?? []) {
        if ('criterio' in row) {
          row.criterion = row.criterio;
          delete row.criterio;
          touched = true;
        }
        if ('nota' in row) {
          row.score = row.nota;
          delete row.nota;
          touched = true;
        }
      }
      if (sc.costs?.unit === 'USD/mês') {
        sc.costs.unit = 'USD/month';
        note(dir, 'scorecard.costs.unit: USD/mês → USD/month');
        touched = true;
      }
      if (touched) writeFile(scPath, JSON.stringify(sc, null, 2) + '\n');
    } catch (e) {
      console.error(`${path.basename(dir)}: scorecard.json unreadable (${e.message}) — skipped`);
    }
  }

  // 4 + 5. markers and cross-file references inside every .md (and diagram.mmd)
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(md|mmd)$/.test(name)) continue;
    const p = path.join(dir, name);
    const before = fs.readFileSync(p, 'utf8');
    let after = before;
    for (const [re, to] of MD_MARKERS) after = after.replace(re, to);
    for (const [from, to] of Object.entries(FILE_RENAMES)) after = after.split(from).join(to);
    if (after !== before) {
      writeFile(p, after);
      note(dir, `markers/references rewritten in ${name}`);
    }
  }

  // 6. .state.json: re-key to the new names and refresh the hashes. The files'
  // bytes changed only because of this migration — charging the session with a
  // stale-propagation warning for that would be noise, not a finding.
  const statePath = path.join(dir, '.state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const hashes = {};
      for (const name of ORDER) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) hashes[name] = dryRun ? (state.hashes ?? {})[name] ?? 'dry-run' : hashFile(p);
      }
      const notes = state.notes ?? state.notas;
      const next = { hashes, at: state.at ?? new Date().toISOString(), notes: Array.isArray(notes) ? notes : [] };
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        writeFile(statePath, JSON.stringify(next, null, 2));
        note(dir, '.state.json re-keyed and re-hashed');
      }
    } catch (e) {
      console.error(`${path.basename(dir)}: .state.json unreadable (${e.message}) — skipped`);
    }
  }
}

const dirs = all
  ? (fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }) : [])
      .filter((d) => d.isDirectory())
      .map((d) => path.join(SESSIONS_DIR, d.name))
  : [target.includes('/') ? path.resolve(target) : path.join(SESSIONS_DIR, target)];

for (const dir of dirs) migrateSession(dir);

console.log(changes.length ? changes.join('\n') : 'nothing to migrate — every name is already current');
console.log(`\n${dirs.length} session(s) · ${changes.length} change(s)${dryRun ? ' (dry run — nothing written)' : ''}`);
