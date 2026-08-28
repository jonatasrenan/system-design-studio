// Linha do tempo de uma conversa (transcript JSONL do Claude Code): tool calls,
// durações e gaps de geração — para avaliar onde o tempo de uma sessão foi gasto.
// Uso:
//   node tools/timing.mjs <caminho/do/transcript.jsonl>
//   node tools/timing.mjs --latest   # transcript mais recente deste projeto
//   [--gap <s>]                      # só mostra gaps maiores que isso (default 5)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const gapMin = args.includes('--gap') ? Number(args[args.indexOf('--gap') + 1]) : 5;
let file = args.find((a) => !a.startsWith('--') && a !== String(gapMin));

if (args.includes('--latest') || !file) {
  const projDir = path.join(os.homedir(), '.claude', 'projects', ROOT.replaceAll('/', '-'));
  if (!fs.existsSync(projDir)) {
    console.error(`sem transcripts em ${projDir}`);
    process.exit(1);
  }
  const cands = fs
    .readdirSync(projDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(projDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!cands.length) {
    console.error('nenhum transcript encontrado');
    process.exit(1);
  }
  file = cands[0];
}

const hint = (name, input = {}) => {
  const h =
    input.command ??
    input.skill ??
    input.file_path?.split('/').slice(-1)[0] ??
    input.prompt?.slice(0, 50) ??
    '';
  return String(h).replace(/\s+/g, ' ').slice(0, 70);
};

const calls = new Map(); // tool_use_id -> {name, hint, ts}
const events = []; // {ts, kind:'call'|'result'|'user', id?}
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  const ts = o.timestamp ? Date.parse(o.timestamp) : null;
  if (!ts) continue;
  const content = o.message?.content;
  // mensagem REAL do usuário = fronteira de turno (separa "esperando usuário" de "geração")
  if (o.type === 'user' && !o.isMeta) {
    const isText =
      typeof content === 'string' ||
      (Array.isArray(content) && content.some((c) => c.type === 'text') && !content.some((c) => c.type === 'tool_result'));
    if (isText) {
      events.push({ ts, kind: 'user' });
      continue;
    }
  }
  if (!Array.isArray(content)) continue;
  for (const c of content) {
    if (o.type === 'assistant' && c.type === 'tool_use') {
      calls.set(c.id, { name: c.name, hint: hint(c.name, c.input), ts });
      events.push({ ts, kind: 'call', id: c.id });
    } else if (o.type === 'user' && c.type === 'tool_result') {
      events.push({ ts, kind: 'result', id: c.tool_use_id });
    }
  }
}
events.sort((a, b) => a.ts - b.ts);
if (!events.length) {
  console.error('nenhum tool call no transcript');
  process.exit(1);
}

const fmt = (ts) => new Date(ts).toTimeString().slice(0, 8);
const dur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`);

let prevEnd = null;
let toolMs = 0;
let waitMs = 0; // intervalo que termina numa mensagem do usuário = esperando o usuário
let genMs = 0; // demais intervalos = geração
const started = new Map(); // id -> call ts (para casar resultado)
console.log(`transcript: ${file}\n`);
for (const e of events) {
  const interval = prevEnd !== null ? e.ts - prevEnd : 0;
  if (e.kind === 'user') {
    if (interval > 0) waitMs += interval;
    if (interval >= gapMin * 1000) console.log(`${fmt(prevEnd)}  ~esperando usuário~ ${dur(interval)}`);
    console.log(`${fmt(e.ts)}  — mensagem do usuário —`);
    prevEnd = Math.max(prevEnd ?? e.ts, e.ts);
    continue;
  }
  const call = calls.get(e.id);
  if (!call) continue;
  if (e.kind === 'call') {
    if (interval > 0) genMs += interval;
    if (interval >= gapMin * 1000) console.log(`${fmt(prevEnd)}  ~geração~           ${dur(interval)}`);
    started.set(e.id, e.ts);
    prevEnd = Math.max(prevEnd ?? e.ts, e.ts);
  } else {
    const t0 = started.get(e.id);
    if (t0 === undefined) continue;
    started.delete(e.id);
    const ms = e.ts - t0;
    toolMs += ms;
    console.log(`${fmt(t0)}  ${call.name.padEnd(10)} ${dur(ms).padStart(7)}  ${call.hint}`);
    prevEnd = Math.max(prevEnd ?? e.ts, e.ts);
  }
}
const span = events[events.length - 1].ts - events[0].ts;
console.log(
  `\ntotal: ${dur(span)} · ferramentas: ${dur(toolMs)} (${((toolMs / span) * 100).toFixed(0)}%) · geração: ${dur(genMs)} (${((genMs / span) * 100).toFixed(0)}%) · esperando usuário: ${dur(waitMs)} (${((waitMs / span) * 100).toFixed(0)}%)`
);
