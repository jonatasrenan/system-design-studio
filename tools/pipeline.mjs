// Modelo compartilhado do pipeline de uma sessão (usado pelo checker e pelo viewer).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TEMPLATE_BY_FILE } from './templates.mjs';

// ordem do pipeline: mudança em i invalida j > i não-tocado.
// É também a ordem das abas no viewer.
export const ORDER = [
  '00-problema.md',
  '10-requisitos.md',
  '20-estimativas.md',
  '30-design.md',
  '40-tradeoffs.md',
  '50-operacao.md',
  'diagram.mmd',
  'scorecard.json',
  '90-duvidas.md',
  '45-review.md',
  '70-poc.md',
  '60-avaliacao.md',
];

// etapas opcionais: ausência nunca reprova (nem em sessão concluída)
export const OPTIONAL = ['70-poc.md', '90-duvidas.md'];

export const hashFile = (p) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

// Jargão interno que não pode vazar para artefatos compartilháveis (ver CLAUDE.md).
// "baseline" sozinho é termo técnico legítimo — só forma de comando e nomes internos contam.
export const JARGON =
  /\/(design|review|grade|interview|harness-eval)\b|\bharness\b|\bchecker\b|--baseline|(check|eval|share|stage|new-session|scorecard)\.mjs|scorecard\.json|learnings\.md|SKILL\.md|\b(primeira|segunda|pr[óo]xima|1ª|2ª) passada\b|\bpassada (1|2|leve|preliminar|de refer[êe]ncia)\b|me corrija|nest[ae] revis[ãa]o|revis[ãa]o preliminar|fica(m)? para o polimento/i;

// Parser leve do diagram.mmd (flowchart): nós com rótulo/forma/subgraph e arestas.
// Cobre as formas usadas no repositório: id["x"] id[(x)] id[[x]] id((x)) id{x} id(x) id[x].
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

// Status de cada etapa em relação à última baseline (.state.json):
//   ok            — existe e não divergiu; nenhum upstream divergiu
//   editado       — divergiu da baseline (trabalho em andamento)
//   desatualizado — não foi tocada, mas algum upstream divergiu
//   pendente      — ainda não existe
// Sem baseline, só existe ok/pendente (consistência ainda não rastreada).
export function stageStatus(dir) {
  let base = null;
  try {
    base = JSON.parse(fs.readFileSync(path.join(dir, '.state.json'), 'utf8')).hashes ?? {};
  } catch {}
  const stages = [];
  let upstreamChanged = false;
  // estado de CONTEÚDO do review: FALHAs abertas nos guardrails deixam a etapa vermelha
  let falhasAbertas = 0;
  try {
    falhasAbertas = JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8'))?.guardrails?.falha ?? 0;
  } catch {}
  for (const name of ORDER) {
    const p = path.join(dir, name);
    const exists = fs.existsSync(p);
    // stub: o arquivo ainda é o template intocado (aba laranja no viewer)
    let stub = false;
    if (exists && TEMPLATE_BY_FILE[name]) {
      try {
        stub = fs.readFileSync(p, 'utf8') === TEMPLATE_BY_FILE[name];
      } catch {}
    }
    // scorecard: nasce com esqueleto no new-session — semanticamente vazio conta
    // como "pendente" (aba desligada), não como etapa existente
    let scEmpty = false;
    if (exists && name === 'scorecard.json') {
      try {
        const sc = JSON.parse(fs.readFileSync(p, 'utf8'));
        const empty = (a) => !Array.isArray(a) || a.length === 0;
        scEmpty =
          empty(sc.slos) && empty(sc.capacity) && empty(sc.components) &&
          empty(sc.costs?.items) && !sc.guardrails && !sc.rubric && empty(sc.risks);
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
    // review só "fecha" (verde) com todos os itens PASS/N-A; staleness (desatualizado) tem prioridade
    if (name === '45-review.md' && exists && falhasAbertas > 0 && status !== 'desatualizado') {
      status = 'falhas';
      stub = false;
    }
    stages.push({ name, exists: exists && !scEmpty, status, stub });
  }
  return { baseline: base !== null, stages };
}

// Memória do usuário (learnings/argumentário) é pessoal e fica fora do versionamento:
// o repositório versiona só os `.template.md`. Criar na primeira necessidade.
export function ensureMemoryFiles(root) {
  for (const name of ['learnings.md', 'argumentario.md']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) continue;
    const tpl = path.join(root, name.replace(/\.md$/, '.template.md'));
    if (fs.existsSync(tpl)) fs.copyFileSync(tpl, file);
  }
}

// `.env` na raiz: configuração pessoal (bucket, distribution, perfil AWS) fora do
// versionamento. O ambiente de verdade sempre vence o arquivo.
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

// --- escrita segura, compartilhada pelas ferramentas ---------------------------
// tmp + rename: um leitor concorrente nunca vê o arquivo pela metade.
export function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Lock por diretório (mkdir é atômico no filesystem). Devolve a função que libera;
// também libera se o processo sair por process.exit() no meio da operação — sem
// isso um caminho de erro deixaria a próxima escrita esperando 60 s pelo órfão.
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
        console.error(`lock ocupado há muito tempo: ${lockDir} — outro processo travou? remova se for órfão`);
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
