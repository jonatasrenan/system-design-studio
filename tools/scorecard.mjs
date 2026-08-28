// Patch determinístico do scorecard.json — JSON nunca é editado por texto pela LLM.
// Uso: node tools/scorecard.mjs <slug|caminho> <comando> ['<json>']
//      (sem o argumento json, ou com "-", o payload é lido do stdin — preferível:
//       evita quoting de aspas/cifrão no shell; use heredoc)
//
// Comando preferido (funde vários blocos em UMA chamada):
//   apply  '{"components":[...],"costs":[...],"slos":[...],"capacity":[...],
//            "risks":[...],"guardrails":{...},"rubric":{...},"unit":"USD/mês"}'
//   (todas as chaves opcionais; components/costs/slos/capacity fazem upsert,
//    risks faz append com dedupe, guardrails/rubric substituem, unit ajusta costs.unit)
//
// Comandos granulares (legado, todos idempotentes; upsert casa pela chave natural):
//   upsert-components '[{"name","purpose","why"?,"rejected"?:[],"tradeoff"?}]'   (chave: name)
//   upsert-costs      '[{"component","cost","notes"}]'                            (chave: component)
//   upsert-slos       '[{"name","target"}]'                                       (chave: name)
//   upsert-capacity   '[{"name","value"}]'                                        (chave: name)
//   add-risks         '["texto do risco"]'                                        (append, dedupe exato)
//   set-guardrails    '{"pass","falha","na","falhas":[]}'
//   set-rubric        '{"overall","scores":[{"criterio","nota"}]}'
//   remove-components '["name1","name2"]'   remove-costs '["component1"]'
//
// Sempre atualiza meta.updated. Imprime resumo do que mudou.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockFile, writeAtomic } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target, cmd, jsonArg] = process.argv.slice(2);
if (!target || !cmd) {
  console.error("uso: node tools/scorecard.mjs <slug|caminho> <comando> ['<json>' | - (stdin)]");
  process.exit(1);
}
const dir = target.includes('/') ? path.resolve(target) : path.join(ROOT, 'sessions', target);
const scPath = path.join(dir, 'scorecard.json');
if (!fs.existsSync(dir)) {
  console.error(`sessão não encontrada: ${dir}`);
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
// read-modify-write sob lock: o fluxo emite vários applies em paralelo e, sem isso,
// o último a escrever apagava os blocos dos outros — todos reportando sucesso.
const releaseLock = lockFile(scPath);
let sc = SKELETON;
if (fs.existsSync(scPath)) {
  // arquivo corrompido NUNCA é resetado em silêncio — abortamos para não apagar dados
  try {
    sc = { ...SKELETON, ...JSON.parse(fs.readFileSync(scPath, 'utf8')) };
  } catch (e) {
    console.error(`scorecard.json existente mas inválido (${e.message}) — corrija o arquivo antes de aplicar patches`);
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
    console.error('payload ausente: passe o JSON como argumento ou via stdin');
    process.exit(1);
  }
}
let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  console.error(`json inválido: ${e.message}`);
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
    if (!item?.[key]) fail(`item sem chave "${key}": ${JSON.stringify(item)}`);
    const i = list.findIndex((x) => x[key] === item[key]);
    if (i >= 0) {
      list[i] = { ...list[i], ...item };
      updated++;
    } else {
      list.push(item);
      added++;
    }
  }
  return `${added} adicionado(s), ${updated} atualizado(s)`;
}

const validGuardrails = (p) =>
  p && ['pass', 'falha', 'na'].every((k) => typeof p[k] === 'number') && Array.isArray(p.falhas ?? []);
const validRubric = (p) => p && typeof p.overall === 'number' && Array.isArray(p.scores);
const stringArray = (p) => Array.isArray(p) && p.every((x) => typeof x === 'string');

function addRisks(arr) {
  const list = Array.isArray(arr) ? arr : [arr];
  if (!list.every((r) => typeof r === 'string')) fail('risks deve ser lista de strings');
  const fresh = list.filter((r) => !sc.risks.includes(r));
  sc.risks.push(...fresh);
  return `${fresh.length} adicionado(s)`;
}

const summaries = [];
switch (cmd) {
  case 'apply': {
    if (typeof payload !== 'object' || Array.isArray(payload)) fail('apply espera um objeto multi-bloco');
    const known = ['components', 'costs', 'slos', 'capacity', 'risks', 'guardrails', 'rubric', 'unit'];
    const unknown = Object.keys(payload).filter((k) => !known.includes(k));
    if (unknown.length) fail(`blocos desconhecidos em apply: ${unknown.join(', ')} (aceitos: ${known.join(', ')})`);
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
      if (!validGuardrails(payload.guardrails)) fail('guardrails malformado: {pass,falha,na:números, falhas:[...]}');
      sc.guardrails = payload.guardrails;
      summaries.push(`guardrails: ${payload.guardrails.pass} pass · ${payload.guardrails.falha} falha`);
    }
    if (payload.rubric) {
      if (!validRubric(payload.rubric)) fail('rubric malformado: {overall:número, scores:[...]}');
      sc.rubric = payload.rubric;
      summaries.push(`rubric: overall ${payload.rubric.overall}`);
    }
    if (!summaries.length) fail('apply sem nenhum bloco — nada a fazer');
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
    if (!validGuardrails(payload)) fail('guardrails malformado: {pass,falha,na:números, falhas:[...]}');
    sc.guardrails = payload;
    summaries.push(`guardrails: ${payload.pass} pass · ${payload.falha} falha · ${payload.na} n/a`);
    break;
  case 'set-rubric':
    if (!validRubric(payload)) fail('rubric malformado: {overall:número, scores:[...]}');
    sc.rubric = payload;
    summaries.push(`rubric: overall ${payload.overall}`);
    break;
  case 'remove-components':
    if (!stringArray(payload)) fail('remove-components espera lista de nomes');
    sc.components = sc.components.filter((c) => !payload.includes(c.name));
    summaries.push('components removidos');
    break;
  case 'remove-costs':
    if (!stringArray(payload)) fail('remove-costs espera lista de componentes');
    sc.costs.items = sc.costs.items.filter((c) => !payload.includes(c.component));
    summaries.push('costs removidos');
    break;
  default:
    fail(`comando desconhecido: ${cmd}`);
}

writeAtomic(scPath, JSON.stringify(sc, null, 2) + '\n');
try {
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.updated = new Date().toISOString().slice(0, 10);
  writeAtomic(metaPath, JSON.stringify(meta, null, 2) + '\n');
} catch (e) {
  console.error(`aviso: meta.json não atualizado (${e.message})`);
}
releaseLock();
console.log(summaries.join('\n'));
