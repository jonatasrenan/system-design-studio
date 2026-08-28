// Publica um design como página estática em <SD_SHARE_BASE>/<uuid>/index.html (S3 + CloudFront, UUID por caminho).
//
// Uso:
//   node tools/share.mjs <slug|caminho>            # gera e publica (cria uuid na 1ª vez)
//   node tools/share.mjs <slug> --dry-run          # só gera o html, mostra o caminho
//   node tools/share.mjs <slug> --off              # desliga o auto-republish
//   node tools/share.mjs <slug> --quiet            # modo silencioso (usado pelo viewer)
//
// O viewer (server.mjs) chama este script automaticamente quando uma sessão
// compartilhada muda — o agente nunca faz deploy manualmente.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);
// Destino do deploy — configuracao do ambiente, nada hardcoded:
//   SD_SHARE_BUCKET  bucket S3 que serve as paginas          (obrigatorio)
//   SD_SHARE_BASE    URL publica na frente do bucket         (obrigatorio)
//   SD_SHARE_DIST    distribution CloudFront a invalidar     (opcional)
//   AWS_PROFILE / AWS_REGION  credenciais e regiao           (opcional, herda o ambiente)
const BUCKET = process.env.SD_SHARE_BUCKET;
const DIST_ID = process.env.SD_SHARE_DIST || '';
const BASE_URL = (process.env.SD_SHARE_BASE || '').replace(/\/+$/, '');
const AWS_ENV = { ...process.env, AWS_DEFAULT_REGION: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' };
const requireEnv = () => {
  const faltando = [!BUCKET && 'SD_SHARE_BUCKET', !BASE_URL && 'SD_SHARE_BASE'].filter(Boolean);
  if (faltando.length) {
    console.error(`compartilhamento nao configurado: defina ${faltando.join(' e ')} (veja README)`);
    process.exit(1);
  }
};

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
const quiet = args.includes('--quiet');
const off = args.includes('--off');
const del = args.includes('--delete');
const log = (...a) => !quiet && console.log(...a);
if (!target) {
  console.error('uso: node tools/share.mjs <slug|caminho> [--dry-run|--off|--delete|--quiet]');
  process.exit(1);
}
const dir = target.includes('/') ? path.resolve(target) : path.join(ROOT, 'sessions', target);
const metaPath = path.join(dir, 'meta.json');
if (!fs.existsSync(metaPath)) {
  console.error(`sessão não encontrada: ${dir}`);
  process.exit(1);
}
let meta;
try {
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
} catch (e) {
  console.error(`meta.json inválido em ${dir}: ${e.message}`);
  process.exit(1);
}

if (off) {
  if (meta.share) meta.share.auto = false;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  log('auto-republish desligado');
  process.exit(0);
}

if (del) {
  // remove do S3 e apaga o registro de compartilhamento. O uuid é a identidade
  // permanente do design: compartilhar de novo devolve a MESMA URL.
  const delUuid = meta.uuid ?? meta.share?.uuid;
  if (!delUuid || !meta.share) {
    log('sessão não está compartilhada');
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
    console.error(`remoção no S3 falhou: ${e.message}`);
    process.exit(1);
  }
  delete meta.share;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  log('descompartilhado (removido do S3)');
  process.exit(0);
}

if (!dry) requireEnv(); // dry-run só gera o HTML: não precisa de bucket nem de URL pública

// uuid é a identidade PERMANENTE do design (criado com a sessão pelo new-session.mjs;
// gerado aqui só para sessões antigas). Compartilhar/descompartilhar liga/desliga a
// publicação — a URL é sempre a mesma.
if (!meta.uuid) {
  meta.uuid = meta.share?.uuid ?? crypto.randomUUID(); // migra formato antigo se houver
  if (!dry) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
}
const shareUrl = `${BASE_URL || 'https://exemplo.invalid'}/${meta.uuid}/index.html`; // sem SD_SHARE_BASE só ocorre em dry-run
if (!meta.share || meta.share.url !== shareUrl) {
  meta.share = { url: shareUrl, auto: meta.share?.auto ?? true };
  if (!dry) {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    log(`compartilhamento: ${shareUrl}`);
  }
}

// --- coleta dos dados da sessão ---
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
const diagram = fs.existsSync(path.join(dir, 'diagram.mmd')) ? fs.readFileSync(path.join(dir, 'diagram.mmd'), 'utf8') : null;
let scorecard = null;
try {
  scorecard = JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8'));
} catch {}
// --- payload idêntico ao do /api/session do viewer (a página compartilhada É o painel) ---
const { stageStatus } = await import('./pipeline.mjs');
// mesmo critério do viewer: scorecard.json fica fora do "arquivo mudado por último",
// senão a página pula para a Visão Geral a cada atualização do scorecard.
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
const data = {
  slug: path.basename(dir),
  meta: { title: meta.title, mode: meta.mode, status: meta.status, updated: meta.updated },
  files,
  diagram,
  scorecard,
  pipeline: stageStatus(dir),
  lastChanged,
};

// a página pública não expõe a avaliação (nota/lacunas do candidato são material interno)
data.files = data.files.filter((f) => f.name !== '60-avaliacao.md');
data.pipeline.stages = data.pipeline.stages.filter((s) => s.name !== '60-avaliacao.md');

// --- html autocontido: MESMO app.js e style.css do viewer, em modo estático ---
// Toda melhoria no painel entra automaticamente aqui; divergências são combinadas com o usuário.
const pub = (f) => fs.readFileSync(path.join(ROOT, 'viewer', 'public', f), 'utf8');
const css = pub('style.css');
const markedJs = pub('vendor/marked.min.js');
const mermaidJs = pub('vendor/mermaid.min.js');
const appJs = pub('app.js');
const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
const buildAt = new Date().toISOString();
// hash do código da página: dados novos com mesmo código → atualização suave; código novo → reload completo
const appHash = crypto.createHash('sha1').update(appJs).update(css).digest('hex').slice(0, 12);

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>${meta.title} - jonatasrenan</title>
<style>${css}</style>
</head>
<body>
<header>
  <h1>${meta.title} - jonatasrenan</h1>
  <select id="session-select" title="Sessão"></select>
  <span id="session-badges"></span>
  <button id="follow-btn" title="Quando ligado, a página acompanha a etapa mais recente do design"></button>
  <span id="live-dot" title="atualiza sozinho">●</span>
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
log(`html gerado: ${outFile} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);

if (dry) {
  log('(dry-run — nada foi enviado)');
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
  console.error(`deploy falhou: ${e.message}`);
  process.exit(1);
}
