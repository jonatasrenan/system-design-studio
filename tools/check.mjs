// Checker de consistência das sessões.
//
// Duas classes de verificação, ambas determinísticas:
//  - estruturais: meta.json/scorecard.json válidos; sessão "concluido" exige
//    review presente e guardrails sem FALHA.
//  - staleness: o pipeline é um DAG linear (problema → requisitos → estimativas
//    → design → trade-offs → operação → diagrama/scorecard → dúvidas → review
//    → poc → avaliação; a ordem canônica é ORDER, em pipeline.mjs).
//    Um `.state.json` por sessão guarda os hashes do último estado consistente
//    (baseline). Se um arquivo upstream mudou desde a baseline e algum downstream
//    não mudou, o downstream está potencialmente desatualizado — o agente precisa
//    revisitá-lo (atualizar ou confirmar que nada muda) e rodar --baseline.
//
// Uso:
//   node tools/check.mjs                  # verifica todas as sessões
//   node tools/check.mjs <slug>           # verifica uma sessão
//   node tools/check.mjs <slug> --baseline  # valida estrutura e marca o estado como consistente
//   node tools/check.mjs <slug> --lint    # lints determinísticos de review (diagrama, filas, jargão...)
//   node tools/check.mjs --hook           # modo Stop-hook: exit 2 bloqueia o turno
//
// Escopo por agente (execução paralela): com a variável de ambiente SD_SESSION=<slug>,
// o modo --hook (e a chamada sem slug) verifica SÓ essa sessão — o Stop hook de um
// agente nunca é bloqueado pela sessão em andamento de outro. Slug explícito na linha
// de comando continua tendo prioridade. Em --hook, SD_SESSION apontando para sessão
// que ainda não existe é ignorada (exit 0).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER, hashFile, stageStatus, parseDiagram, JARGON, writeAtomic } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS_DIR = path.join(ROOT, 'sessions');

// aceita um slug de sessions/ ou um caminho de diretório (ex.: golden de eval)
const resolveDir = (slug) => (slug.includes('/') ? path.resolve(slug) : path.join(SESSIONS_DIR, slug));

function checkSession(slug) {
  const dir = resolveDir(slug);
  const problems = [];
  const file = (n) => path.join(dir, n);
  if (!fs.existsSync(dir)) return [`sessão não encontrada: ${slug} (verifique o slug em sessions/)`];

  // --- estruturais ---
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(file('meta.json'), 'utf8'));
    for (const k of ['title', 'mode', 'status'])
      if (!meta[k]) problems.push(`meta.json sem campo "${k}"`);
  } catch (e) {
    problems.push(`meta.json ausente ou inválido: ${e.message}`);
  }

  let scorecard = null;
  if (fs.existsSync(file('scorecard.json'))) {
    try {
      scorecard = JSON.parse(fs.readFileSync(file('scorecard.json'), 'utf8'));
      for (const it of scorecard?.costs?.items ?? []) {
        if (typeof it.cost !== 'number') problems.push(`scorecard: custo não-numérico em "${it.component}"`);
        if (it.cost10x !== undefined && typeof it.cost10x !== 'number')
          problems.push(`scorecard: cost10x não-numérico em "${it.component}"`);
      }
    } catch (e) {
      problems.push(`scorecard.json inválido: ${e.message}`);
    }
  }

  if (meta?.status === 'concluido') {
    if (!fs.existsSync(file('45-review.md')))
      problems.push('status "concluido" sem 45-review.md (rode a revisão de guardrails)');
    const g = scorecard?.guardrails;
    if (!g) problems.push('status "concluido" sem bloco guardrails no scorecard');
    else if (g.falha > 0) problems.push(`status "concluido" com ${g.falha} FALHA(s) aberta(s) nos guardrails`);
  }

  // --- ritual de baseline: design de pé sem baseline = consistência não rastreada ---
  const { baseline: hasBaseline, stages } = stageStatus(dir);
  if (!hasBaseline && fs.existsSync(file('30-design.md')) && fs.existsSync(file('40-tradeoffs.md'))) {
    problems.push(
      `design de pé sem baseline de consistência — rode: node tools/check.mjs ${slug} --baseline ` +
        `(sem ela, mudanças de premissa não são rastreadas)`
    );
  }
  if (hasBaseline) {
    const changed = stages.filter((s) => s.status === 'editado').map((s) => s.name);
    const stale = stages.filter((s) => s.status === 'desatualizado').map((s) => s.name);
    if (changed.length && stale.length) {
      problems.push(
        `mudou desde a última baseline: ${changed.join(', ')} — ` +
          `desatualizados (não tocados): ${stale.join(', ')}. ` +
          `Propague a mudança (ou confirme que cada um não é afetado) e rode: ` +
          `node tools/check.mjs ${slug} --baseline`
      );
    }
  }

  return problems;
}

function baseline(slug, force) {
  const dir = resolveDir(slug);
  if (!fs.existsSync(dir)) {
    console.error(`sessão não encontrada: ${slug}`);
    process.exit(1);
  }
  // valida a estrutura antes de gravar — baseline sobre estado quebrado congela o problema.
  // (staleness pendente NÃO bloqueia: resolvê-la é exatamente o papel da baseline)
  const structural = checkSession(slug).filter((p) => !/baseline/.test(p));
  if (structural.length && !force) {
    console.error(`estrutura inválida — corrija antes de gravar a baseline (ou use --force):\n- ${structural.join('\n- ')}`);
    process.exit(1);
  }
  const hashes = {};
  for (const name of ORDER) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) hashes[name] = hashFile(p);
  }
  fs.writeFileSync(path.join(dir, '.state.json'), JSON.stringify({ hashes, at: new Date().toISOString() }, null, 2));
  console.log(`baseline gravada para ${slug} (${Object.keys(hashes).length} arquivos)`);
}

// --- lints determinísticos de review: o que é regex/parse sai da LLM e vive aqui ---
const TAXONOMY = ['👤', '🌐', '🧭', '⚙️', '🗄️', '⚡', '📨', '⏱️', '📊', '🛡️', '🔌'];
function lintSession(slug) {
  const dir = resolveDir(slug);
  if (!fs.existsSync(dir)) {
    console.error(`sessão não encontrada: ${slug}`);
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
  let sc = null;
  try {
    sc = JSON.parse(read('scorecard.json'));
  } catch {}
  const comps = sc?.components ?? [];
  const costs = sc?.costs?.items ?? [];
  const diagram = read('diagram.mmd');

  if (diagram) {
    const { nodes, edges, subgraphs } = parseDiagram(diagram);
    if (subgraphs.length < 2) falhas.push('diagrama sem agrupamentos (subgraphs) — ilegível');
    const isActor = (n) => /cliente/i.test(n.subgraph ?? '') || n.label.includes('👤');
    // token-overlap ≥ 0.5 — mesmo critério do casamento nó↔ficha do viewer
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
      if (!hasComp(n)) falhas.push(`nó "${n.id}" sem entrada em components (legenda) no scorecard`);
      if (!hasCost(n)) falhas.push(`nó "${n.id}" sem entrada em costs.items no scorecard`);
      if (n.lines > 3) avisos.push(`nó "${n.id}" com rótulo de ${n.lines} linhas (budget: 3 — detalhe pertence à ficha)`);
      if (!TAXONOMY.some((e) => n.label.includes(e))) noEmoji.push(n.id);
      // fila = forma [[...]] ou rótulo que COMEÇA nomeando uma fila ("página de fila" não conta)
      const isQueue = n.shape === '[[' || /^"?\s*(fila|queue|t[óo]pico|stream)\b/i.test(n.label);
      if (isQueue) {
        const ficha = comps.find((c) => matches(n.label, c.name));
        const texto = `${n.label} ${ficha?.purpose ?? ''} ${ficha?.failure ?? ''}`;
        if (!/DLQ|perda aceita|descarte|dead.?letter/i.test(texto))
          falhas.push(`fila "${n.id}" sem destino de falha declarado (DLQ + reprocesso, ou "perda aceita")`);
      }
    }
    if (noEmoji.length) avisos.push(`${noEmoji.length} nó(s) sem emoji da taxonomia: ${noEmoji.join(', ')}`);
    for (const n of nodes)
      if (/observabilidad|telemetria|monitor(amento|ing)\b/i.test(n.label))
        avisos.push(
          `nó "${n.id}" parece coleta de telemetria — coleta universal não se desenha (sinais vivem na operação); mantenha só se for componente do próprio problema`
        );
    if (nodes.length > 15) avisos.push(`diagrama com ${nodes.length} nós (budget: ~15 — considere um nó-sistema + sub-diagrama de zoom)`);
    const numbered = edges.filter((e) => /^"?\s*\d+\s*[·.]/.test(e.label));
    if (!numbered.length) falhas.push('nenhuma aresta numerada — o fluxo principal deve contar a história (1·, 2·…)');
    else {
      const first = numbered.find((e) => /^"?\s*1\s*[·.]/.test(e.label));
      const fromNode = first && nodes.find((n) => n.id === first.from);
      if (first && fromNode && !isActor(fromNode))
        falhas.push(`a aresta 1· parte de "${first.from}" — o fluxo deve começar na chegada do usuário (subgraph de clientes)`);
    }
    const actors = nodes.filter(isActor);
    if (actors.length === 1) avisos.push('nenhum ator além do usuário final (organizador/back-office/ops — quase todo sistema tem)');
  } else {
    falhas.push('diagram.mmd ausente');
  }

  for (const f of ORDER.filter((n) => n.endsWith('.md'))) {
    const c = read(f);
    if (!c) continue;
    for (const [i, line] of c.split('\n').entries())
      if (JARGON.test(line)) falhas.push(`jargão interno em ${f}:${i + 1} — artefatos são compartilháveis`);
  }

  const tradeoffs = read('40-tradeoffs.md');
  if (tradeoffs) {
    const entries = (tradeoffs.match(/^##\s+(?!Decisões adiadas|Referências de mercado)/gm) ?? []).length;
    const defesas = (tradeoffs.match(/Defesa em 30s/g) ?? []).length;
    if (entries > defesas) avisos.push(`${entries - defesas} trade-off(s) sem "Defesa em 30s"`);
  }

  for (const f of falhas) console.log(`FALHA: ${f}`);
  for (const a of avisos) console.log(`aviso: ${a}`);
  console.log(`\nlint: ${falhas.length} falha(s) · ${avisos.length} aviso(s)`);
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
    console.error('uso: node tools/check.mjs <slug> --baseline [--force]');
    process.exit(1);
  }
  baseline(slugArg, args.includes('--force'));
  process.exit(0);
}

if (doLint) {
  if (!slugArg) {
    console.error('uso: node tools/check.mjs <slug> --lint');
    process.exit(1);
  }
  // --lint é portão: FALHA sai != 0 para poder ser usado em gate, como o modo hook
  process.exit(lintSession(slugArg) ? 0 : 1);
}

let slugs = slugArg ? [slugArg] : allSlugs();
// hook escopado por SD_SESSION: sessão ainda não criada não é problema — é o agente que
// ainda não rodou new-session; nada a verificar
if (hookMode && envSlug && slugArg === envSlug && !fs.existsSync(resolveDir(envSlug))) slugs = [];

// Em modo hook, sessão com atividade nos últimos 2 min é trabalho EM ANDAMENTO
// de alguma conversa — o dono dela propaga e baselina no próprio turno.
// Sem a carência, o Stop hook de uma conversa bloqueia pelo meio-do-turno de outra.
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
  // lido do Stop hook: exit 2 bloqueia o encerramento do turno e devolve o
  // stderr ao agente. Se o hook já bloqueou uma vez neste encadeamento
  // (stop_hook_active), libera com aviso para não entrar em loop infinito.
  let stopHookActive = false;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    stopHookActive = !!JSON.parse(stdin).stop_hook_active;
  } catch {}
  if (!report.length) process.exit(0);
  const msg = `Sessões de system design inconsistentes:\n- ${report.join('\n- ')}`;
  if (stopHookActive) {
    console.log(`${msg}\n(aviso: já houve um bloqueio neste turno; liberando para evitar loop)`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(2);
}

if (!report.length) {
  console.log(`ok — ${slugs.length} sessão(ões) consistente(s)`);
} else {
  console.log(report.map((r) => `✗ ${r}`).join('\n'));
  process.exit(1);
}
