// System design harness viewer.
// Zero dependencies: serves the frontend, exposes sessions as JSON, and
// notifies file changes via SSE so the tabs update on their own.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageStatus, ensureMemoryFiles, loadEnv, RETIRED_STAGES } from '../tools/pipeline.mjs';

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
      // a session deleted/renamed mid-scan (or unreadable) must not take down
      // the server: this path also runs on the republish timer, without a request.
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
      .filter((f) => f.endsWith('.md') && !RETIRED_STAGES.includes(f))
      .sort()
      .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
    const diagramPath = path.join(dir, 'diagram.mmd');
    const diagram = fs.existsSync(diagramPath) ? fs.readFileSync(diagramPath, 'utf8') : null;
    let scorecard = null;
    try {
      scorecard = JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8'));
    } catch {}
    // the CONTENT file modified last — the frontend's "follow" mode opens its tab.
    // scorecard.json is excluded: it's a side artifact updated alongside the content —
    // following it would make the panel jump to the Overview on every apply. A retired
    // stage's file (an old clone, a stray manual write) never becomes "last changed" either.
    let lastChanged = null;
    let lastMtime = 0;
    for (const f of fs.readdirSync(dir)) {
      if (f === 'meta.json' || f === 'scorecard.json' || f.startsWith('.') || RETIRED_STAGES.includes(f)) continue;
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
    // session removed/renamed mid-read
    return null;
  }
}

const ROOT_DOCS = ['learnings.md', 'patterns.md', 'guardrails.md'];
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

// --- auto-republishing of shared sessions (tools/share.mjs) ---
// A session with meta.share.auto !== false is re-published by the server
// itself when it changes — the agent never deploys.
import { spawn } from 'node:child_process';
const publishState = new Map(); // slug -> { publishedAt, running, timer }
function sessionMtime(dir) {
  let m = 0;
  for (const f of fs.readdirSync(dir)) {
    // .state.json (baseline) COUNTS: it changes the pipeline colors on the published page
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
          console.log(`↻ share republished: ${s.slug}`);
        } else console.log(`⚠ share failed (${code}): ${s.slug} — ${errBuf.trim().split('\n').pop() ?? 'no stderr'}`);
        scheduleRepublish(); // pick up changes that happened during the publish
      });
    }, 5000); // debounce: wait for the agent's burst of writes to settle
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
      patterns: readRootDoc('patterns.md'),
      guardrails: readRootDoc('guardrails.md'),
    });
  if (req.method !== 'POST' && url.pathname.startsWith('/api/session/')) {
    const slug = decodeURIComponent(url.pathname.slice('/api/session/'.length));
    const session = readSession(slug);
    return session ? json(res, 200, session) : json(res, 404, { error: 'not found' });
  }
  // share / unshare from the panel — the server calls tools/share.mjs
  if (req.method === 'POST' && /^\/api\/session\/[^/]+\/(share|unshare)$/.test(url.pathname)) {
    const [, , , rawSlug, action] = url.pathname.split('/');
    const slug = decodeURIComponent(rawSlug);
    const dir = path.join(SESSIONS_DIR, slug);
    if (!path.resolve(dir).startsWith(SESSIONS_DIR + path.sep) || !fs.existsSync(dir)) return json(res, 404, { error: 'not found' });
    const shareArgs = [path.join(ROOT, 'tools', 'share.mjs'), slug, '--quiet'];
    if (action === 'unshare') shareArgs.push('--delete');
    const child = spawn('node', shareArgs, { stdio: 'ignore' });
    child.on('exit', (code) => {
      if (code !== 0) return json(res, 500, { error: `share.mjs exited with ${code} — is the aws cli configured?` });
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

  // static files
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(file));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('404');
  }
  // no-cache: the browser revalidates on every load — a change to app.js/style.css
  // takes effect on the next refresh, no hard-refresh or mismatched strip version
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`port ${PORT} already in use — the viewer is probably already running at http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

// Loopback by default: the local panel shouldn't be visible on the network
// (sharing with third parties is share.mjs's job). HOST= overrides it.
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`viewer at http://localhost:${PORT}`);
});
