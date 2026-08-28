// Escrita SEGURA nos arquivos globais de memória (learnings.md / argumentario.md).
// Esses dois arquivos são o único estado compartilhado entre sessões que o fluxo
// escreve (grade passo 5b/7, review passo 6). Com vários agentes em paralelo, a
// edição por texto (Read → Edit) vira read-modify-write concorrente e perde itens.
// Aqui a escrita acontece sob lock (mkdir atômico + retry), relendo o arquivo
// dentro da seção crítica, com dedupe por título.
//
// Uso:
//   node tools/learnings.mjs append [--target learnings|argumentario] [--session <slug>]
//       ← stdin: um ou mais itens markdown começando com "## <título>" (formato do arquivo)
//         itens cujo "## <título>" já existe são ignorados (avisa) — para reforçar um item
//         existente use `note`; para promover use `promote`
//   node tools/learnings.mjs promote "<título exato>" --session <slug>
//       muda **Status** para dominado e anota a sessão que comprovou na **Origem**
//   node tools/learnings.mjs note "<título exato>" "<texto>" [--target ...]
//       acrescenta " · <texto>" ao fim da linha **Origem** (ex.: "recorreu em sessions/<slug>")
//   [--file <caminho>] sobrescreve o alvo (testes); [--quiet] só imprime erros.
// Sempre idempotente por título; nunca reescreve itens existentes além do campo pedido.
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
const FILES = { learnings: 'learnings.md', argumentario: 'argumentario.md' };
if (!cmd || !['append', 'promote', 'note'].includes(cmd) || !FILES[target]) {
  console.error('uso: node tools/learnings.mjs append|promote|note ... [--target learnings|argumentario] [--session <slug>]');
  process.exit(1);
}
ensureMemoryFiles(ROOT);
const file = opt('--file') ? path.resolve(opt('--file')) : path.join(ROOT, FILES[target]);
const log = (...m) => !quiet && console.log(...m);
const today = new Date().toISOString().slice(0, 10);
const origem = session ? `sessions/${session} (${today})` : `(${today})`;

// --- lock: mkdir é atômico no filesystem; lock órfão (> 60 s) é removido ---
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
        console.error(`lock ocupado há muito tempo: ${lockDir} — outro agente travou? remova manualmente se for órfão`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    }
  }
  // libera também quando fn() sai por process.exit() (validação falhou): sem isso o
  // lock órfão fazia a próxima escrita esperar 15 s e falhar.
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

// --- parsing: itens = blocos "## título" fora de fences ``` ---
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

// escrita atômica: tmp + rename (leitor nunca vê arquivo pela metade)
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
      console.error('append: stdin vazio — envie um ou mais itens "## título" no formato do arquivo');
      process.exit(1);
    }
    const { items: newItems, lines: newLines } = splitItems(input);
    if (!newItems.length) {
      console.error('append: nenhum "## título" encontrado no stdin');
      process.exit(1);
    }
    const blocks = [];
    const vistos = new Set(); // duplicata DENTRO do mesmo payload também é duplicata
    for (const it of newItems) {
      if (vistos.has(norm(it.title))) {
        log(`repetido no mesmo envio (ignorado): ${it.title}`);
        continue;
      }
      vistos.add(norm(it.title));
      if (existing.has(norm(it.title))) {
        log(`já existe (ignorado): ${it.title} — use note/promote para reforçar`);
        continue;
      }
      let block = newLines.slice(it.start, it.end).join('\n').trimEnd();
      // origem automática quando o bloco não trouxe (learnings) — sessão informada
      if (session && target === 'learnings' && !/\*\*Origem\*\*/.test(block))
        block = block.replace(/(\*\*Status\*\*:.*)$/m, `$1\n- **Origem**: ${origem}`);
      if (session && target === 'argumentario' && !/\*\*Visto em\*\*/.test(block)) block += `\n- **Visto em**: ${origem}`;
      blocks.push(block);
    }
    if (!blocks.length) return log('nada a acrescentar');
    // remove o placeholder de arquivo vazio (argumentario nasce com ele)
    let out = md.replace(/^_\(vazio[^\n]*\)_\s*$/m, '').replace(/\s+$/, '');
    out = `${out}\n\n${blocks.join('\n\n')}\n`;
    writeAtomic(file, out);
    log(`${path.basename(file)}: ${blocks.length} item(ns) acrescentado(s)${session ? ` (origem ${origem})` : ''}`);
    return;
  }

  const it = a1 && existing.get(norm(a1));
  if (!it) {
    console.error(`item não encontrado em ${path.basename(file)}: "${a1}" (títulos: ${items.map((i) => i.title).join(' | ')})`);
    process.exit(1);
  }
  const block = lines.slice(it.start, it.end);
  const idx = (re) => block.findIndex((l) => re.test(l));
  if (cmd === 'promote') {
    const si = idx(/^-\s*\*\*Status\*\*:/);
    if (si < 0) {
      console.error('item sem linha **Status**');
      process.exit(1);
    }
    if (/dominado/.test(block[si])) log(`já dominado: ${it.title}`);
    block[si] = block[si].replace(/:\s*.*$/, ': dominado');
    const oi = idx(/^-\s*\*\*Origem\*\*:/);
    const nota = `comprovado em ${origem}`;
    if (oi >= 0 && !block[oi].includes(nota)) block[oi] = `${block[oi].trimEnd()} · ${nota}`;
    log(`promovido: ${it.title} (${nota})`);
  } else {
    if (!a2) {
      console.error('note: informe o texto');
      process.exit(1);
    }
    const oi = idx(/^-\s*\*\*(Origem|Visto em)\*\*:/);
    if (oi < 0) {
      console.error('item sem linha **Origem**/**Visto em**');
      process.exit(1);
    }
    if (block[oi].includes(a2)) return log(`nota já presente: ${it.title}`);
    block[oi] = `${block[oi].trimEnd()} · ${a2}`;
    log(`anotado em "${it.title}": ${a2}`);
  }
  const out = [...lines.slice(0, it.start), ...block, ...lines.slice(it.end)].join('\n');
  writeAtomic(file, out);
});
