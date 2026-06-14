// Build a single human-readable review report of every AUTO-GENERATED knowledge
// base's "studied & failed" (excludedAgents) and pipeline drugs, with the real
// citation behind each, so a human/clinician can sign off before these are
// trusted. Generated KBs are marked reviewed:false until then.
//
// Usage: node scripts/kb-review-report.mjs  ->  writes data/kb/_REVIEW.md
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, '..', 'data', 'kb');

const files = fs.readdirSync(KB_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
const kbs = files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(KB_DIR, f), 'utf8')); } catch { return null; } })
  .filter(Boolean)
  .sort((a, b) => (a.condition || '').localeCompare(b.condition || ''));

const auto = kbs.filter(k => k.reviewed === false);
const lines = [];
lines.push('# Knowledge Base — Review Sheet');
lines.push('');
lines.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
lines.push('');
lines.push(`These ${auto.length} knowledge bases were AUTO-GENERATED from real PubMed literature and are marked \`reviewed: false\`. Each "studied & failed" drug below cites the exact paper it came from. Please confirm each one is a genuine *efficacy failure for that disease* (not just a side effect). When a KB is verified, set \`"reviewed": true\` in its JSON file.`);
lines.push('');
lines.push('---');
lines.push('');

let totalExcluded = 0;
for (const k of auto) {
  const ids = Object.fromEntries((k.items || []).map(i => [i.id, i]));
  lines.push(`## ${k.condition}  \`${k.slug}\``);
  lines.push(`items: ${(k.items||[]).length} · canonical facts: ${(k.canonicalFacts||[]).length} · pipeline: ${(k.pipelineDrugs||[]).length} · **studied & failed: ${(k.excludedAgents||[]).length}**`);
  lines.push('');
  if ((k.excludedAgents || []).length) {
    lines.push('**Studied & failed (verify each):**');
    for (const x of k.excludedAgents) {
      totalExcluded++;
      const it = ids[x.evidenceRef] || {};
      const cite = it.title ? `${it.title}${it.year ? ` (${it.year})` : ''}` : '(missing citation!)';
      const url = it.url || (it.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/` : '');
      lines.push(`- [ ] **${x.name}** — ${x.reason}`);
      lines.push(`      ↳ ${cite}${url ? `  ${url}` : ''}`);
    }
  } else {
    lines.push('_No studied-and-failed drugs surfaced (conservative; add known ones by hand if needed)._');
  }
  lines.push('');
}

lines.push('---');
lines.push(`Total studied-and-failed entries to review: **${totalExcluded}** across ${auto.length} diseases.`);
lines.push('');
lines.push(`Hand-curated KBs (already reviewed, not listed): ${kbs.length - auto.length}.`);

fs.writeFileSync(path.join(KB_DIR, '_REVIEW.md'), lines.join('\n'));
console.log(`Wrote data/kb/_REVIEW.md — ${auto.length} auto KBs, ${totalExcluded} excluded-agent entries to review.`);
