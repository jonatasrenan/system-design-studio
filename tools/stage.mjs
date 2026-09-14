// Creates session stages from the templates (ready-made headings, the LLM only fills them in).
// Usage: node tools/stage.mjs <slug> <stage> [<stage>...] [--print]
//   stages: requirements | estimates | domain | design | data-model | tradeoffs |
//           operations | faq | poc
//   (domain and data-model are optional, causally placed stages — see pipeline.mjs
//   ORDER/OPTIONAL and the design skill for when they're proposed by default)
// Idempotent: an existing file isn't overwritten. Updates meta.updated once.
// --print: does NOT create a file — prints the templates to stdout. Use this when you'll
//   fill in the stage in the same turn: Write to a new file skips the Read.
//   Creating it for real is for stages that will stay "on the way" (orange tab in the viewer).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from './templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const [slug, ...stagesArgs] = argv.filter((a) => a !== '--print');
if (!slug || !stagesArgs.length || stagesArgs.some((s) => !TEMPLATES[s])) {
  console.error(`usage: node tools/stage.mjs <slug> <${Object.keys(TEMPLATES).join('|')}> [...] [--print]`);
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
  console.error(`session not found: ${dir}`);
  process.exit(1);
}
let created = 0;
for (const stage of stagesArgs) {
  const [file, content] = TEMPLATES[stage];
  const p = path.join(dir, file);
  if (fs.existsSync(p)) {
    console.log(`already exists: ${file}`);
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
    console.error(`warning: meta.json not updated (${e.message})`);
  }
