// Deterministic patching of scorecard.json — the LLM never edits JSON as text.
// Usage: node tools/scorecard.mjs <slug|path> <command> ['<json>']
//      (without the json argument, or with "-", the payload is read from stdin — preferred:
//       avoids quoting/escaping quotes and $ in the shell; use a heredoc)
//
// Preferred command (merges several blocks in ONE call):
//   apply  '{"components":[...],"costs":[...],"slos":[...],"capacity":[...],
//            "risks":[...],"guardrails":{...},"rubric":{...},"unit":"USD/mês"}'
//   (all keys optional; components/costs/slos/capacity upsert,
//    risks appends with dedupe, guardrails/rubric replace, unit adjusts costs.unit)
//
// Granular commands (legacy, all idempotent; upsert matches on the natural key):
//   upsert-components '[{"name","purpose","why"?,"rejected"?:[],"tradeoff"?}]'   (key: name)
//   upsert-costs      '[{"component","cost","notes"}]'                            (key: component)
//   upsert-slos       '[{"name","target"}]'                                       (key: name)
//   upsert-capacity   '[{"name","value"}]'                                        (key: name)
//   add-risks         '["risk text"]'                                             (append, exact dedupe)
//   set-guardrails    '{"pass","falha","na","premissas"?,"riscos"?,"falhas":[]}'   (premissas/riscos default 0)
//   set-rubric        '{"overall","scores":[{"criterio","nota"}]}'
//   remove-components '["name1","name2"]'   remove-costs '["component1"]'
//
// Always updates meta.updated. Prints a summary of what changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockFile, writeAtomic } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target, cmd, jsonArg] = process.argv.slice(2);
if (!target || !cmd) {
  console.error("usage: node tools/scorecard.mjs <slug|path> <command> ['<json>' | - (stdin)]");
  process.exit(1);
}
const dir = target.includes('/') ? path.resolve(target) : path.join(ROOT, 'sessions', target);
const scPath = path.join(dir, 'scorecard.json');
if (!fs.existsSync(dir)) {
  console.error(`session not found: ${dir}`);
  process.exit(1);
}

const SKELETON = {
  slos: [],
  capacity: [],
  components: [],
  costs: { unit: 'USD/mês', items: [] },
  guardrails: null,
  rubric: null,
  risks: [],
};
// read-modify-write under lock: the flow emits several applies in parallel and, without
// this, the last writer would wipe out the other blocks — while everyone reported success.
const releaseLock = lockFile(scPath);
let sc = SKELETON;
if (fs.existsSync(scPath)) {
  // a corrupted file is NEVER silently reset — we abort instead of wiping out data
  try {
    sc = { ...SKELETON, ...JSON.parse(fs.readFileSync(scPath, 'utf8')) };
  } catch (e) {
    console.error(`scorecard.json exists but is invalid (${e.message}) — fix the file before applying patches`);
    process.exit(1);
  }
}

let raw = jsonArg;
if (raw === undefined || raw === '-') {
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    console.error('missing payload: pass the JSON as an argument or via stdin');
    process.exit(1);
  }
}
let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  console.error(`invalid json: ${e.message}`);
  process.exit(1);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

function upsert(list, items, key) {
  const arr = Array.isArray(items) ? items : [items];
  let added = 0,
    updated = 0;
  for (const item of arr) {
    if (!item?.[key]) fail(`item missing key "${key}": ${JSON.stringify(item)}`);
    const i = list.findIndex((x) => x[key] === item[key]);
    if (i >= 0) {
      list[i] = { ...list[i], ...item };
      updated++;
    } else {
      list.push(item);
      added++;
    }
  }
  return `${added} added, ${updated} updated`;
}

// premissas/riscos are optional (default 0) so old scorecards without them stay valid;
// when present they must be numbers ≥ 0, like the other three counters.
const validGuardrails = (p) =>
  p &&
  ['pass', 'falha', 'na'].every((k) => typeof p[k] === 'number') &&
  ['premissas', 'riscos'].every((k) => p[k] === undefined || (typeof p[k] === 'number' && p[k] >= 0)) &&
  Array.isArray(p.falhas ?? []);
const normalizeGuardrails = (p) => ({ premissas: 0, riscos: 0, ...p });
const validRubric = (p) => p && typeof p.overall === 'number' && Array.isArray(p.scores);
const stringArray = (p) => Array.isArray(p) && p.every((x) => typeof x === 'string');

function addRisks(arr) {
  const list = Array.isArray(arr) ? arr : [arr];
  if (!list.every((r) => typeof r === 'string')) fail('risks must be a list of strings');
  const fresh = list.filter((r) => !sc.risks.includes(r));
  sc.risks.push(...fresh);
  return `${fresh.length} added`;
}

const summaries = [];
switch (cmd) {
  case 'apply': {
    if (typeof payload !== 'object' || Array.isArray(payload)) fail('apply expects a multi-block object');
    const known = ['components', 'costs', 'slos', 'capacity', 'risks', 'guardrails', 'rubric', 'unit'];
    const unknown = Object.keys(payload).filter((k) => !known.includes(k));
    if (unknown.length) fail(`unknown blocks in apply: ${unknown.join(', ')} (accepted: ${known.join(', ')})`);
    sc.costs ??= { unit: 'USD/mês', items: [] };
    if (payload.unit) {
      sc.costs.unit = payload.unit;
      summaries.push(`unit: ${payload.unit}`);
    }
    if (payload.components) summaries.push(`components: ${upsert(sc.components, payload.components, 'name')}`);
    if (payload.costs) {
      const items = Array.isArray(payload.costs) ? payload.costs : payload.costs.items;
      if (payload.costs.unit) sc.costs.unit = payload.costs.unit;
      summaries.push(`costs: ${upsert(sc.costs.items, items, 'component')}`);
    }
    if (payload.slos) summaries.push(`slos: ${upsert(sc.slos, payload.slos, 'name')}`);
    if (payload.capacity) summaries.push(`capacity: ${upsert(sc.capacity, payload.capacity, 'name')}`);
    if (payload.risks) summaries.push(`risks: ${addRisks(payload.risks)}`);
    if (payload.guardrails) {
      if (!validGuardrails(payload.guardrails))
        fail('malformed guardrails: {pass,falha,na:numbers, premissas?,riscos?:numbers >= 0, falhas:[...]}');
      sc.guardrails = normalizeGuardrails(payload.guardrails);
      summaries.push(
        `guardrails: ${sc.guardrails.pass} pass · ${sc.guardrails.falha} falha · ${sc.guardrails.premissas} premissa(s) · ${sc.guardrails.riscos} risco(s)`
      );
    }
    if (payload.rubric) {
      if (!validRubric(payload.rubric)) fail('malformed rubric: {overall:number, scores:[...]}');
      sc.rubric = payload.rubric;
      summaries.push(`rubric: overall ${payload.rubric.overall}`);
    }
    if (!summaries.length) fail('apply with no blocks — nothing to do');
    break;
  }
  case 'upsert-components':
    summaries.push(`components: ${upsert(sc.components, payload, 'name')}`);
    break;
  case 'upsert-costs':
    sc.costs ??= { unit: 'USD/mês', items: [] };
    summaries.push(`costs: ${upsert(sc.costs.items, payload, 'component')}`);
    break;
  case 'upsert-slos':
    summaries.push(`slos: ${upsert(sc.slos, payload, 'name')}`);
    break;
  case 'upsert-capacity':
    summaries.push(`capacity: ${upsert(sc.capacity, payload, 'name')}`);
    break;
  case 'add-risks':
    summaries.push(`risks: ${addRisks(payload)}`);
    break;
  case 'set-guardrails':
    if (!validGuardrails(payload))
      fail('malformed guardrails: {pass,falha,na:numbers, premissas?,riscos?:numbers >= 0, falhas:[...]}');
    sc.guardrails = normalizeGuardrails(payload);
    summaries.push(
      `guardrails: ${sc.guardrails.pass} pass · ${sc.guardrails.falha} falha · ${sc.guardrails.na} n/a · ${sc.guardrails.premissas} premissa(s) · ${sc.guardrails.riscos} risco(s)`
    );
    break;
  case 'set-rubric':
    if (!validRubric(payload)) fail('malformed rubric: {overall:number, scores:[...]}');
    sc.rubric = payload;
    summaries.push(`rubric: overall ${payload.overall}`);
    break;
  case 'remove-components':
    if (!stringArray(payload)) fail('remove-components expects a list of names');
    sc.components = sc.components.filter((c) => !payload.includes(c.name));
    summaries.push('components removed');
    break;
  case 'remove-costs':
    if (!stringArray(payload)) fail('remove-costs expects a list of components');
    sc.costs.items = sc.costs.items.filter((c) => !payload.includes(c.component));
    summaries.push('costs removed');
    break;
  default:
    fail(`unknown command: ${cmd}`);
}

writeAtomic(scPath, JSON.stringify(sc, null, 2) + '\n');
try {
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.updated = new Date().toISOString().slice(0, 10);
  writeAtomic(metaPath, JSON.stringify(meta, null, 2) + '\n');
} catch (e) {
  console.error(`warning: meta.json not updated (${e.message})`);
}
releaseLock();
console.log(summaries.join('\n'));
