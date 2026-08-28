// Viewer do harness de system design.
// Zero dependências: serve o frontend, expõe as sessões como JSON e
// notifica mudanças de arquivo via SSE para as abas atualizarem sozinhas.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageStatus, ensureMemoryFiles, loadEnv } from '../tools/pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');
loadEnv(ROOT);
const PORT = Number(process.env.PORT || 4400);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(SESSIONS_DIR, d.name);
      let mtime = 0;
      // sessão apagada/renomeada no meio da varredura (ou ilegível) não pode derrubar
      // o servidor: este caminho roda também no timer de republicação, sem request.
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        return null;
      }
      for (const f of files) {
        try {
          mtime = Math.max(mtime, fs.statSync(path.join(dir, f)).mtimeMs);
        } catch {}
      }
      const meta = readMeta(dir);
      return { slug: d.name, title: meta.title || d.name, mode: meta.mode, status: meta.status, mtime };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function readSession(slug) {
  const dir = path.join(SESSIONS_DIR, slug);
  if (!path.resolve(dir).startsWith(SESSIONS_DIR + path.sep) || !fs.existsSync(dir)) return null;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
    const diagramPath = path.join(dir, 'diagram.mmd');
    const diagram = fs.existsSync(diagramPath) ? fs.readFileSync(diagramPath, 'utf8') : null;
    let scorecard = null;
    try {
      scorecard = JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8'));
    } catch {}
    // arquivo de CONTEÚDO modificado por último — o modo "seguir" do frontend abre a aba dele.
    // scorecard.json fica de fora: é artefato lateral atualizado junto com o conteúdo —
    // segui-lo faria o painel pular para a Visão Geral a cada apply.
    let lastChanged = null;
    let lastMtime = 0;
    for (const f of fs.readdirSync(dir)) {
      if (f === 'meta.json' || f === 'scorecard.json' || f.startsWith('.')) continue;
      try {
        const m = fs.statSync(path.join(dir, f)).mtimeMs;
        if (m > lastMtime) {
          lastMtime = m;
          lastChanged = f;
        }
      } catch {}
    }
    return { slug, meta: readMeta(dir), files, diagram, scorecard, pipeline: stageStatus(dir), lastChanged };
  } catch {
    // sessão removida/renomeada no meio da leitura
    return null;
  }
}

const ROOT_DOCS = ['learnings.md', 'rubric.md', 'guardrails.md', 'argumentario.md'];
function readRootDoc(name) {
  const p = path.join(ROOT, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// --- SSE ---
const clients = new Set();
let debounce = null;
function broadcastChange() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const payload = `data: ${JSON.stringify({ at: Date.now() })}\n\n`;
    for (const res of clients) res.write(payload);
    scheduleRepublish();
  }, 150);
}

// --- auto-republish de sessões compartilhadas (tools/share.mjs) ---
// Sessão com meta.share.auto !== false é re-publicada pelo próprio servidor
// quando muda — o agente nunca faz deploy.
import { spawn } from 'node:child_process';
const publishState = new Map(); // slug -> { publishedAt, running, timer }
function sessionMtime(dir) {
  let m = 0;
  for (const f of fs.readdirSync(dir)) {
    // .state.json (baseline) CONTA: muda as cores do pipeline na página publicada
    if (f.startsWith('.') && f !== '.state.json') continue;
    try {
      m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs);
    } catch {}
  }
  return m;
}
function scheduleRepublish() {
  for (const s of listSessions()) {
    const dir = path.join(SESSIONS_DIR, s.slug);
    const meta = readMeta(dir);
    if (!meta.share || meta.share.auto === false) continue;
    const st = publishState.get(s.slug) ?? { publishedAt: 0, running: false, timer: null };
    publishState.set(s.slug, st);
    if (st.running || sessionMtime(dir) <= st.publishedAt) continue;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.running = true;
      const at = sessionMtime(dir);
      const child = spawn('node', [path.join(ROOT, 'tools', 'share.mjs'), s.slug, '--quiet'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errBuf = '';
      child.stderr.on('data', (d) => (errBuf += d));
      child.on('exit', (code) => {
        st.running = false;
        if (code === 0) {
          st.publishedAt = at;
          console.log(`↻ share republicado: ${s.slug}`);
        } else console.log(`⚠ share falhou (${code}): ${s.slug} — ${errBuf.trim().split('\n').pop() ?? 'sem stderr'}`);
        scheduleRepublish(); // pega mudanças ocorridas durante o publish
      });
    }, 5000); // debounce: espera a rajada de writes do agente assentar
  }
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
ensureMemoryFiles(ROOT);
fs.watch(SESSIONS_DIR, { recursive: true }, broadcastChange);
fs.watch(ROOT, (event, filename) => {
  if (ROOT_DOCS.includes(filename)) broadcastChange();
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (url.pathname === '/api/sessions')
    return json(res, 200, {
      sessions: listSessions(),
      learnings: readRootDoc('learnings.md'),
      rubric: readRootDoc('rubric.md'),
      guardrails: readRootDoc('guardrails.md'),
      argumentario: readRootDoc('argumentario.md'),
    });
  if (req.method !== 'POST' && url.pathname.startsWith('/api/session/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/session/'.length));
    const session = readSession(slug);
    return session ? json(res, 200, session) : json(res, 404, { error: 'não encontrada' });
  }
  // compartilhar / descompartilhar pelo painel — o servidor chama tools/share.mjs
  if (req.method === 'POST' && /^\/api\/session\/[^/]+\/(share|unshare)$/.test(url.pathname)) {
    const [, , , rawSlug, action] = url.pathname.split('/');
    const slug = decodeURIComponent(rawSlug);
    const dir = path.join(SESSIONS_DIR, slug);
    if (!path.resolve(dir).startsWith(SESSIONS_DIR + path.sep) || !fs.existsSync(dir)) return json(res, 404, { error: 'não encontrada' });
    const shareArgs = [path.join(ROOT, 'tools', 'share.mjs'), slug, '--quiet'];
    if (action === 'unshare') shareArgs.push('--delete');
    const child = spawn('node', shareArgs, { stdio: 'ignore' });
    child.on('exit', (code) => {
      if (code !== 0) return json(res, 500, { error: `share.mjs saiu com ${code} — aws cli configurado?` });
      const meta = readMeta(dir);
      json(res, 200, { share: meta.share ?? null });
      if (action === 'share') {
        const st = publishState.get(slug) ?? { publishedAt: 0, running: false, timer: null };
        st.publishedAt = sessionMtime(dir);
        publishState.set(slug, st);
      }
    });
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // estáticos
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(file));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('404');
  }
  // no-cache: o navegador revalida a cada load — mudança em app.js/style.css
  // vale no próximo refresh, sem hard-refresh nem versão desencontrada da faixa
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`porta ${PORT} já em uso — o viewer provavelmente já está rodando em http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

// Loopback por padrão: o painel local não deve ficar visível na rede
// (o compartilhamento com terceiros é papel do share.mjs). HOST= sobrescreve.
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`viewer em http://localhost:${PORT}`);
});
