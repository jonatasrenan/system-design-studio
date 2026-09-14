// Publishes a design as a static page at <SD_SHARE_BASE>/<uuid>/index.html (S3 + CloudFront, UUID per path).
//
// Usage:
//   node tools/share.mjs <slug|path>                # generates and publishes (creates a uuid the 1st time)
//   node tools/share.mjs <slug> --dry-run            # only generates the html, shows the path
//   node tools/share.mjs <slug> --off                # turns off auto-republish
//   node tools/share.mjs <slug> --quiet              # silent mode (used by the viewer)
//
// The viewer (server.mjs) calls this script automatically when a shared session
// changes — the agent never deploys manually.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv, RETIRED_STAGES } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);
// Deploy target — configured through the environment, nothing hardcoded:
//   SD_SHARE_BUCKET  S3 bucket that serves the pages              (required)
//   SD_SHARE_BASE    public URL in front of the bucket            (required)
//   SD_SHARE_DIST    CloudFront distribution to invalidate        (optional)
//   AWS_PROFILE / AWS_REGION  credentials and region               (optional, inherits the environment)
const BUCKET = process.env.SD_SHARE_BUCKET;
const DIST_ID = process.env.SD_SHARE_DIST || '';
const BASE_URL = (process.env.SD_SHARE_BASE || '').replace(/\/+$/, '');
const AWS_ENV = { ...process.env, AWS_DEFAULT_REGION: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' };
const requireEnv = () => {
  const missingEnv = [!BUCKET && 'SD_SHARE_BUCKET', !BASE_URL && 'SD_SHARE_BASE'].filter(Boolean);
  if (missingEnv.length) {
    console.error(`sharing not configured: set ${missingEnv.join(' and ')} (see README)`);
    process.exit(1);
  }
};

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
const quiet = args.includes('--quiet');
const off = args.includes('--off');
const del = args.includes('--delete');
// optional links for the published page's top bar: where the reader came from and the
// sibling version of the same design (another language, say). Stored in meta.share so
// every republish keeps them; a session without them gets no bar at all.
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const backLink = flagValue('--back') ? { url: flagValue('--back'), label: flagValue('--back-label') || '← back' } : undefined;
const altLink = flagValue('--alt') ? { url: flagValue('--alt'), label: flagValue('--alt-label') || flagValue('--alt') } : undefined;
const log = (...a) => !quiet && console.log(...a);
if (!target) {
  console.error(
    'usage: node tools/share.mjs <slug|path> [--dry-run|--off|--delete|--quiet] [--back <url> --back-label <text>] [--alt <url> --alt-label <text>]'
  );
  process.exit(1);
}
const dir = target.includes('/') ? path.resolve(target) : path.join(ROOT, 'sessions', target);
const metaPath = path.join(dir, 'meta.json');
if (!fs.existsSync(metaPath)) {
  console.error(`session not found: ${dir}`);
  process.exit(1);
}
let meta;
try {
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
} catch (e) {
  console.error(`invalid meta.json in ${dir}: ${e.message}`);
  process.exit(1);
}

if (off) {
  if (meta.share) meta.share.auto = false;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  log('auto-republish turned off');
  process.exit(0);
}

if (del) {
  // removes from S3 and deletes the sharing record. The uuid is the design's
  // permanent identity: sharing again returns the SAME URL.
  const delUuid = meta.uuid ?? meta.share?.uuid;
  if (!delUuid || !meta.share) {
    log('session is not shared');
    process.exit(0);
  }
  requireEnv();
  try {
    execFileSync('aws', ['s3', 'rm', `s3://${BUCKET}/${delUuid}/`, '--recursive', '--only-show-errors'], {
      env: AWS_ENV,
      stdio: quiet ? 'ignore' : 'inherit',
    });
    if (DIST_ID) {
      execFileSync(
        'aws',
        ['cloudfront', 'create-invalidation', '--distribution-id', DIST_ID, '--paths', `/${delUuid}/*`, '--query', 'Invalidation.Id', '--output', 'text'],
        { env: AWS_ENV, stdio: quiet ? 'ignore' : 'inherit' }
      );
    }
  } catch (e) {
    console.error(`S3 removal failed: ${e.message}`);
    process.exit(1);
  }
  delete meta.share;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  log('unshared (removed from S3)');
  process.exit(0);
}

if (!dry) requireEnv(); // dry-run only generates the HTML: doesn't need a bucket or a public URL

// uuid is the design's PERMANENT identity (created with the session by new-session.mjs;
// generated here only for older sessions). Sharing/unsharing toggles publishing —
// the URL is always the same.
if (!meta.uuid) {
  meta.uuid = meta.share?.uuid ?? crypto.randomUUID(); // migrates the old format, if any
  if (!dry) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
}
const shareUrl = `${BASE_URL || 'https://exemplo.invalid'}/${meta.uuid}/index.html`; // no SD_SHARE_BASE only happens on dry-run
if (!meta.share || meta.share.url !== shareUrl) {
  meta.share = { ...(meta.share ?? {}), url: shareUrl, auto: meta.share?.auto ?? true };
  if (!dry) {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    log(`sharing: ${shareUrl}`);
  }
}
if (backLink || altLink) {
  if (backLink) meta.share.back = backLink;
  if (altLink) meta.share.alt = altLink;
  if (!dry) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
}
const escAttr = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const siteBar =
  meta.share.back || meta.share.alt
    ? `<nav class="site-bar">${meta.share.back ? `<a href="${escAttr(meta.share.back.url)}">${escAttr(meta.share.back.label)}</a>` : '<span></span>'}${
        meta.share.alt ? `<a href="${escAttr(meta.share.alt.url)}" class="alt">${escAttr(meta.share.alt.label)}</a>` : ''
      }</nav>\n`
    : '';

// --- collecting the session's data ---
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.md') && !RETIRED_STAGES.includes(f))
  .sort()
  .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
const diagram = fs.existsSync(path.join(dir, 'diagram.mmd')) ? fs.readFileSync(path.join(dir, 'diagram.mmd'), 'utf8') : null;
let scorecard = null;
try {
  scorecard = JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8'));
} catch {}
// --- payload identical to the viewer's /api/session (the shared page IS the panel) ---
const { stageStatus } = await import('./pipeline.mjs');
// same criterion as the viewer: scorecard.json is excluded from "last changed file",
// otherwise the page would jump to the Overview on every scorecard update — and a
// retired stage's leftover file (old clone, stray manual write) never counts either
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
const data = {
  slug: path.basename(dir),
  meta: { title: meta.title, mode: meta.mode, status: meta.status, updated: meta.updated },
  files,
  diagram,
  scorecard,
  pipeline: stageStatus(dir),
  lastChanged,
};

// --- self-contained html: the SAME app.js and style.css as the viewer, in static mode ---
// Every improvement to the panel goes here automatically; divergences are agreed with the user.
const pub = (f) => fs.readFileSync(path.join(ROOT, 'viewer', 'public', f), 'utf8');
const css = pub('style.css');
const markedJs = pub('vendor/marked.min.js');
const mermaidJs = pub('vendor/mermaid.min.js');
const appJs = pub('app.js');
const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
const buildAt = new Date().toISOString();
// hash of the page's code: new data with the same code → smooth update; new code → full reload
const appHash = crypto.createHash('sha1').update(appJs).update(css).digest('hex').slice(0, 12);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<meta name="referrer" content="no-referrer"/>
<title>${meta.title} - jonatasrenan</title>
<style>${css}</style>
</head>
<body>
${siteBar}<header>
  <h1>${meta.title} - jonatasrenan</h1>
  <select id="session-select" title="Session"></select>
  <span id="session-badges"></span>
  <button id="follow-btn" title="When on, the page follows the design's most recent stage"></button>
  <span id="live-dot" title="auto-updating">●</span>
</header>
<div id="pipeline"></div>
<main id="content"></main>
<script>${markedJs}</script>
<script>${mermaidJs}</script>
<script>
window.__STATIC__ = true;
window.__BUILD_AT__ = "${buildAt}";
window.__APP_HASH__ = "${appHash}";
window.__DATA__ = ${dataJson};
</script>
<script>${appJs}</script>
</body>
</html>
`;

const outDir = path.join(os.tmpdir(), `sd-share-${meta.uuid}`);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'index.html');
fs.writeFileSync(outFile, html);
const dataFile = path.join(outDir, 'data.json');
fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
log(`html generated: ${outFile} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);

if (dry) {
  log('(dry-run — nothing was sent)');
  process.exit(0);
}

try {
  execFileSync(
    'aws',
    ['s3', 'cp', outFile, `s3://${BUCKET}/${meta.uuid}/index.html`, '--content-type', 'text/html; charset=utf-8', '--cache-control', 'max-age=15', '--only-show-errors'],
    { env: AWS_ENV, stdio: quiet ? 'ignore' : 'inherit' }
  );
  execFileSync(
    'aws',
    ['s3', 'cp', dataFile, `s3://${BUCKET}/${meta.uuid}/data.json`, '--content-type', 'application/json; charset=utf-8', '--cache-control', 'max-age=15', '--only-show-errors'],
    { env: AWS_ENV, stdio: quiet ? 'ignore' : 'inherit' }
  );
  if (DIST_ID) {
    execFileSync(
      'aws',
      ['cloudfront', 'create-invalidation', '--distribution-id', DIST_ID, '--paths', `/${meta.uuid}/*`, '--query', 'Invalidation.Id', '--output', 'text'],
      { env: AWS_ENV, stdio: quiet ? 'ignore' : 'inherit' }
    );
  }
  log(`✅ ${meta.share.url}`);
} catch (e) {
  console.error(`deploy failed: ${e.message}`);
  process.exit(1);
}
