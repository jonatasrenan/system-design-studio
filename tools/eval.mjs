// Eval estrutural e determinística de uma sessão de system design.
// Verifica se o harness produziu todos os artefatos com a forma esperada —
// a qualidade semântica continua sendo trabalho do /review e do /grade.
//
// Uso:
//   node tools/eval.mjs <slug|caminho>                 # avalia uma sessão
//   node tools/eval.mjs <slug|caminho> --golden <dir>  # compara cobertura com uma sessão de referência
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER, OPTIONAL, stageStatus, parseDiagram, JARGON } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const goldenDir = args.includes('--golden') ? args[args.indexOf('--golden') + 1] : null;
if (!target) {
  console.error('uso: node tools/eval.mjs <slug|caminho> [--golden <dir>]');
  process.exit(1);
}
const dir = target.includes('/') ? path.resolve(target) : path.join(ROOT, 'sessions', target);
if (!fs.existsSync(dir)) {
  console.error(`sessão não encontrada: ${dir}`);
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
if (meta?.title && meta?.mode && meta?.status) add('ok', 'meta.json válido', `${meta.mode} · ${meta.status}`);
else add('fail', 'meta.json ausente/incompleto');
const concluido = meta?.status === 'concluido';

// --- etapas presentes ---
const present = ORDER.filter((n) => fs.existsSync(path.join(dir, n)));
// 60-avaliacao só é cobrada de sessão concluída — antes do grade, ausência é o esperado
const missing = ORDER.filter(
  (n) => !fs.existsSync(path.join(dir, n)) && !OPTIONAL.includes(n) && !(n === '60-avaliacao.md' && !concluido)
);
add(
  missing.length === 0 ? 'ok' : concluido ? 'fail' : 'warn',
  `etapas do pipeline: ${present.length}/${ORDER.length}`,
  missing.length ? `faltam: ${missing.join(', ')}` : ''
);

// --- história de uma request ---
const design = read('30-design.md');
if (design) {
  const firstH2 = design.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? '';
  if (/hist[óo]ria de uma request/i.test(firstH2)) add('ok', 'design abre com "A história de uma request"');
  else add('fail', 'design não abre com "A história de uma request"', `primeira seção: "${firstH2}"`);
} else add(concluido ? 'fail' : 'warn', '30-design.md ausente');

// --- diagrama ---
const diagram = read('diagram.mmd');
const dgNodes = diagram ? parseDiagram(diagram).nodes : [];
const nodeIds = dgNodes.map((n) => n.id);
// atores (subgraph de clientes) não exigem ficha — mesma isenção do lint
const coverNodes = dgNodes.filter((n) => !/cliente/i.test(n.subgraph ?? ''));
if (diagram && nodeIds.length >= 5 && /subgraph/.test(diagram))
  add('ok', `diagrama com ${nodeIds.length} nós e agrupamentos`);
else if (diagram) add('warn', `diagrama raso (${nodeIds.length} nós, subgraphs: ${/subgraph/.test(diagram)})`);
else add(concluido ? 'fail' : 'warn', 'diagram.mmd ausente');

// --- scorecard ---
const sc = readJson('scorecard.json');
if (!sc) add(concluido ? 'fail' : 'warn', 'scorecard.json ausente/inválido');
else {
  for (const [key, min] of [['slos', 1], ['capacity', 1], ['components', 3]]) {
    const n = sc[key]?.length ?? 0;
    add(n >= min ? 'ok' : concluido ? 'fail' : 'warn', `scorecard.${key}: ${n} item(ns)`);
  }
  const costs = sc.costs?.items ?? [];
  const numeric = costs.every((i) => typeof i.cost === 'number');
  add(
    costs.length >= 3 && numeric ? 'ok' : concluido ? 'fail' : 'warn',
    `scorecard.costs: ${costs.length} componente(s)${numeric ? '' : ' (custos não-numéricos!)'}`
  );
  if (sc.components?.length && coverNodes.length)
    add(
      sc.components.length >= coverNodes.length ? 'ok' : 'warn',
      `cobertura da legenda: ${sc.components.length} objetivos para ${coverNodes.length} nós cobráveis (atores isentos)`
    );
  if (concluido) {
    const g = sc.guardrails;
    if (g && g.falha === 0 && g.pass > 0) add('ok', `guardrails: ${g.pass} pass · 0 falha · ${g.na} n/a`);
    else add('fail', 'concluído sem guardrails limpos no scorecard', JSON.stringify(g ?? null));
    if (sc.rubric?.overall != null && sc.rubric?.scores?.length === 8)
      add('ok', `rubrica avaliada: ${sc.rubric.overall}/4 (8 critérios)`);
    else add('warn', 'rubrica ausente/incompleta no scorecard (grade não rodou?)');
  }
}

// --- review como portão ---
if (concluido) {
  const review = read('45-review.md');
  if (review && /FALHA/i.test(review)) add('ok', '45-review.md presente com veredito por item');
  else add('fail', 'concluído sem 45-review.md substantivo');
}

// --- baseline e consistência ---
const { baseline, stages } = stageStatus(dir);
if (!baseline) add(concluido ? 'fail' : 'warn', 'sem baseline (.state.json) — consistência não rastreada');
else {
  const dirty = stages.filter((s) => s.status === 'editado' || s.status === 'desatualizado');
  if (dirty.length === 0) add('ok', 'baseline consistente (nenhuma etapa suja)');
  else add('fail', 'baseline inconsistente', dirty.map((s) => `${s.name}:${s.status}`).join(', '));
}

// --- jargão interno nos artefatos (páginas são compartilháveis — comandos/mecânica não podem vazar) ---
{
  // regex compartilhada em pipeline.mjs — mesma régua do check.mjs --lint
  const leaks = [];
  for (const f of ORDER.filter((n) => n.endsWith('.md'))) {
    const c = read(f);
    if (!c) continue;
    for (const [i, line] of c.split('\n').entries()) if (JARGON.test(line)) leaks.push(`${f}:${i + 1}`);
  }
  add(leaks.length === 0 ? 'ok' : 'fail', 'artefatos sem jargão interno (compartilháveis)', leaks.slice(0, 5).join(', '));
}

// --- material de defesa (informativo: contagem, não veredito — não falha sessões antigas) ---
if (sc?.components?.length) {
  const n = sc.components.length;
  const count = (k) => sc.components.filter((c) => c[k]).length;
  add('info', `components com "por quê": ${count('why')}/${n}`);
  add('info', `ficha completa (o que é / se falhar / como escala): ${count('what')}/${count('failure')}/${count('scaling')} de ${n}`);
}
const tradeoffs = read('40-tradeoffs.md');
if (tradeoffs) {
  // seções fixas (Decisões adiadas, Referências de mercado) não são trade-offs
  const entries = (tradeoffs.match(/^##\s+(?!Decisões adiadas|Referências de mercado)/gm) ?? []).length;
  const defesas = (tradeoffs.match(/Defesa em 30s/g) ?? []).length;
  add('info', `trade-offs com "Defesa em 30s": ${defesas}/${entries}`);
}
add(fs.existsSync(path.join(dir, '90-duvidas.md')) ? 'ok' : 'warn', 'FAQ antecipada (90-duvidas.md)', 'opcional em sessões antigas');

// --- learnings (repo raiz) ---
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
  `learnings.md: ${learningItems} item(ns)`,
  learningItems === 0 ? 'esperado ≥1 após uma sessão avaliada' : ''
);

// --- comparação com golden ---
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
  console.log('\n— comparação com golden —');
  console.log(`etapas:      candidata ${present.length}/${ORDER.length} · golden ${gPresent.length}/${ORDER.length}`);
  if (gsc && sc) {
    for (const k of ['slos', 'capacity', 'components']) {
      console.log(`${k.padEnd(12)} candidata ${sc[k]?.length ?? 0} · golden ${gsc[k]?.length ?? 0}`);
    }
    console.log(`costs        candidata ${sc.costs?.items?.length ?? 0} · golden ${gsc.costs?.items?.length ?? 0}`);
    console.log(
      `guardrails   candidata ${sc.guardrails ? `${sc.guardrails.pass}p/${sc.guardrails.falha}f` : '—'} · golden ${gsc.guardrails ? `${gsc.guardrails.pass}p/${gsc.guardrails.falha}f` : '—'}`
    );
  }
}

// --- relatório ---
const icon = { ok: '✓', warn: '⚠', fail: '✗', info: '·' };
console.log(`\n=== eval: ${path.basename(dir)} ===`);
for (const r of results) console.log(`${icon[r.level]} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
const counts = { ok: 0, warn: 0, fail: 0, info: 0 };
for (const r of results) counts[r.level]++;
console.log(`\n${counts.ok} ok · ${counts.warn} avisos · ${counts.fail} falhas`);
process.exit(counts.fail ? 1 : 0);
