// Cria etapas de sessão a partir dos templates (cabeçalhos prontos, LLM só preenche).
// Uso: node tools/stage.mjs <slug> <etapa> [<etapa>...] [--print]
//   etapas: requisitos | estimativas | design | tradeoffs | operacao | duvidas | poc
// Idempotente: arquivo existente não é sobrescrito. Atualiza meta.updated uma vez.
// --print: NÃO cria arquivo — imprime os templates no stdout. Use quando for
//   preencher a etapa no mesmo turno: Write em arquivo novo dispensa Read.
//   Criar de verdade é para etapas que ficarão "a caminho" (aba laranja no viewer).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from './templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const [slug, ...stagesArgs] = argv.filter((a) => a !== '--print');
if (!slug || !stagesArgs.length || stagesArgs.some((s) => !TEMPLATES[s])) {
  console.error(`uso: node tools/stage.mjs <slug> <${Object.keys(TEMPLATES).join('|')}> [...] [--print]`);
  process.exit(1);
}
if (printOnly) {
  for (const stage of stagesArgs) {
    const [file, content] = TEMPLATES[stage];
    console.log(`=== ${file} ===\n${content}`);
  }
  process.exit(0);
}
const dir = slug.includes('/') ? path.resolve(slug) : path.join(ROOT, 'sessions', slug);
if (!fs.existsSync(dir)) {
  console.error(`sessão não encontrada: ${dir}`);
  process.exit(1);
}
let created = 0;
for (const stage of stagesArgs) {
  const [file, content] = TEMPLATES[stage];
  const p = path.join(dir, file);
  if (fs.existsSync(p)) {
    console.log(`já existe: ${file}`);
    continue;
  }
  fs.writeFileSync(p, content);
  created++;
  console.log(file);
}
if (created)
  try {
    const metaPath = path.join(dir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.updated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  } catch (e) {
    console.error(`aviso: meta.json não atualizado (${e.message})`);
  }
