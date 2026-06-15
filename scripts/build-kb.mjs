// Auto-generate curated knowledge-base files for common diseases, GROUNDED in
// real PubMed literature so we never introduce hallucinated citations.
//
// Usage:
//   node scripts/build-kb.mjs                       # all in kb-disease-list.json
//   node scripts/build-kb.mjs type-2-diabetes copd  # only these slugs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildKnowledgeBase, slugFromCondition } from '../lib/kb-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const KB_DIR = path.join(ROOT, 'data', 'kb');

try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
} catch {}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env.local');
  process.exit(1);
}

const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'kb-disease-list.json'), 'utf8')).diseases;
const onlySlugs = process.argv.slice(2);
const targets = onlySlugs.length ? list.filter((d) => onlySlugs.includes(d.slug)) : list;

async function buildOne(disease) {
  process.stdout.write(`\n[${disease.slug}] building… `);
  try {
    const kb = await buildKnowledgeBase({
      condition: disease.condition,
      slug: disease.slug || slugFromCondition(disease.condition),
      aliases: disease.aliases || [],
      mode: 'full'
    });
    kb.generatedBy = 'build-kb.mjs (grounded in real PubMed literature)';
    kb.curatedBy = 'auto-grounded generator';
    fs.writeFileSync(path.join(KB_DIR, `${kb.slug}.json`), JSON.stringify(kb, null, 2));
    console.log(`OK items=${kb.items.length} pipeline=${kb.pipelineDrugs.length} excluded=${kb.excludedAgents.length}`);
    return { slug: kb.slug, ok: true, items: kb.items.length, excluded: kb.excludedAgents.length };
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    return { slug: disease.slug, ok: false, error: e.message };
  }
}

const results = [];
for (const d of targets) {
  results.push(await buildOne(d));
}

console.log('\n\n=== BUILD SUMMARY ===');
const ok = results.filter((r) => r.ok);
console.log(`built ${ok.length}/${results.length}`);
results.filter((r) => !r.ok).forEach((r) => console.log(`  FAILED ${r.slug}: ${r.error}`));
console.log(`total excluded agents across KBs: ${ok.reduce((n, r) => n + (r.excluded || 0), 0)}`);
