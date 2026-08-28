// Setup determinístico e COMPLETO de sessão — a LLM nunca datilografa esqueleto
// nem gasta chamadas extras com viewer/learnings.
// Uso: node tools/new-session.mjs "Título do design" [--mode estudio|entrevista]
//                                  [--slug <slug>] [--no-viewer]
// Faz em uma chamada: cria sessions/<yyyy-mm-dd>-<slug>/ (meta.json + scorecard.json),
// garante o viewer de pé (sobe em background se preciso) e imprime no stdout:
//   linha 1: o slug
//   depois:  status do viewer, learnings com status "aberto" e o argumentário.
// O agente usa essa saída direto — sem curl de health nem Reads separados.
//
// Execução paralela (vários agentes, um por sessão):
//   --slug <slug>   nome exato do diretório (o orquestrador pré-atribui nomes únicos e
//                   pode exportar SD_SESSION=<slug> para o agente — ver check.mjs --hook)
//   --no-viewer     (ou SD_NO_VIEWER=1) não checa nem sobe o viewer — o painel é
//                   conveniência interativa, nunca dependência do fluxo
//   a criação do diretório é atômica (mkdir sem recursive): dois agentes com o mesmo
//   slug → exatamente um vence, o outro falha com "sessão já existe".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureMemoryFiles, loadEnv } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const title = args.find((a) => !a.startsWith('--'));
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'estudio';
const slugArg = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
const noViewer = args.includes('--no-viewer') || process.env.SD_NO_VIEWER === '1';
if (!title) {
  console.error('uso: node tools/new-session.mjs "Título do design" [--mode estudio|entrevista] [--slug <slug>] [--no-viewer]');
  process.exit(1);
}
// flag sem valor (no fim da linha) criava sessão sem "mode" — inválida para sempre,
// travando o Stop hook de todo turno até alguém editar meta.json na mão.
if (!['estudio', 'entrevista'].includes(mode)) {
  console.error(`--mode inválido: "${mode ?? '(vazio)'}" — use estudio ou entrevista`);
  process.exit(1);
}
if (args.includes('--slug') && !slugArg) {
  console.error('--slug sem valor');
  process.exit(1);
}
if (slugArg && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(slugArg)) {
  console.error(`--slug inválido: "${slugArg}" (use só [a-z0-9-], ex.: 2026-08-26-meu-design)`);
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
  console.error(`título sem letras nem números ("${title}") — não dá para derivar um nome de sessão; use --slug`);
  process.exit(1);
}
const slug = slugArg ?? `${today}-${slugTitle}`;
const dir = path.join(ROOT, 'sessions', slug);
fs.mkdirSync(path.join(ROOT, 'sessions'), { recursive: true });
// mkdir SEM recursive é atômico: sob concorrência, só um criador passa (EEXIST para os demais)
try {
  fs.mkdirSync(dir);
} catch (e) {
  if (e.code === 'EEXIST') {
    console.error(`sessão já existe: ${slug}`);
    process.exit(1);
  }
  throw e;
}

fs.writeFileSync(
  path.join(dir, 'meta.json'),
  JSON.stringify(
    // uuid: identidade permanente do design — é o caminho público se um dia for compartilhado
    { title, mode, status: 'em-andamento', created: today, updated: today, uuid: crypto.randomUUID() },
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
      rubric: null,
      risks: [],
    },
    null,
    2
  ) + '\n'
);

// (sem stub de 00-problema.md: a LLM o escreve por inteiro na sequência —
//  o stub só custava um Read-antes-de-Write)

console.log(slug);
console.log('criados: meta.json, scorecard.json — 00-problema.md e etapas NÃO existem ainda (Write direto, sem Read)');

// --- viewer: garante de pé, sem chamada separada do agente ---
loadEnv(ROOT);
const PORT = process.env.PORT || process.env.SD_PORT || 4400;
if (noViewer) {
  console.log('viewer: ignorado (--no-viewer)');
} else {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) throw new Error(String(res.status));
    console.log(`viewer: ok (http://localhost:${PORT})`);
  } catch {
    // repassa a porta: sem isso o viewer subiria na 4400 e o health-check apontaria para outra
    const child = spawn('node', [path.join(ROOT, 'viewer', 'server.mjs')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(PORT) },
    });
    child.unref();
    console.log(`viewer: iniciado em background (http://localhost:${PORT}) — avise o usuário para abrir`);
  }
}

// --- learnings abertos + argumentário: entregues aqui, sem Reads separados ---
ensureMemoryFiles(ROOT);
const readRoot = (n) => {
  try {
    return fs.readFileSync(path.join(ROOT, n), 'utf8');
  } catch {
    return '';
  }
};
const learnings = readRoot('learnings.md').replace(/```[\s\S]*?```/g, '');
const abertos = [...learnings.matchAll(/^##\s+(.+)$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/gm)]
  .filter(([, , body]) => /\*\*Status\*\*:\s*aberto/.test(body))
  .map(([, title, body]) => {
    const como = body.match(/\*\*Como aplicar\*\*:\s*(.+)/)?.[1] ?? '';
    return `- ${title.trim()}${como ? ` — ${como.trim()}` : ''}`;
  });
console.log(`\n--- learnings abertos (alertas ativos desta sessão) ---`);
console.log(abertos.length ? abertos.join('\n') : '(nenhum)');
// só as entradas (`## …`), nunca o cabeçalho nem o bloco de formato
const argumentario = readRoot('argumentario.md').replace(/```[\s\S]*?```/g, '');
const padroes = [...argumentario.matchAll(/^##\s[\s\S]*?(?=^##\s|\s*$(?![\s\S]))/gm)].map(([e]) => e.trim());
if (padroes.length) {
  console.log(`\n--- argumentário (padrões já dominados — não rediscutir do zero) ---`);
  console.log(padroes.join('\n\n'));
}
