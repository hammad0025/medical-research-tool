#!/usr/bin/env node
// Build data/disease-registry.json from Every Cure's open disease list.
// Source: https://huggingface.co/datasets/everycure/disease-list (CC-BY-4.0)
//
// Usage:
//   node scripts/build-disease-registry.mjs
//   node scripts/build-disease-registry.mjs --all        # include non-targetable (23k)
//   node scripts/build-disease-registry.mjs --limit 6000   # cap count (for testing)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugFromCondition } from '../lib/kb-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'disease-registry.json');
const PARQUET_URL =
  'https://huggingface.co/api/datasets/everycure/disease-list/parquet/default/train/0.parquet';
const PARQUET_PATH = path.join(ROOT, 'data', '.cache', 'ec-disease-list.parquet');

const args = process.argv.slice(2);
const includeAll = args.includes('--all');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const py = `
import json, sys
try:
    import pyarrow.parquet as pq
except ImportError:
    print("Install pyarrow: pip3 install pyarrow", file=sys.stderr)
    sys.exit(1)

path = ${JSON.stringify(PARQUET_PATH)}
df = pq.read_table(path).to_pandas()
if not ${includeAll ? 'True' : 'False'}:
    df = df[df["official_matrix_filter"] == True]

spec_cols = [c for c in df.columns if c.startswith("speciality_")]
rows = []
for _, r in df.iterrows():
    syns = r.get("synonyms")
    if syns is None or (isinstance(syns, float) and syns != syns):
        syns = []
    elif isinstance(syns, str):
        syns = [s.strip() for s in syns.split(";") if s.strip()]
    elif not isinstance(syns, list):
        syns = list(syns) if syns else []
    syns = [str(s).strip() for s in syns if str(s).strip()][:16]

    orpha = None
    xrefs = str(r.get("crossreferences") or "")
    for part in xrefs.split(";"):
        part = part.strip()
        if part.lower().startswith("orphanet:"):
            orpha = part.split(":", 1)[1].strip()
            break

    group = r.get("harrisons_view") or r.get("mondo_top_grouping") or r.get("mondo_txgnn")
    if group is None or (isinstance(group, float) and group != group):
        group = ""
    else:
        group = str(group).replace("mondo:", "").replace("_", " ").strip()

    specialty = ""
    for c in spec_cols:
        if r.get(c) is True:
            specialty = c.replace("speciality_", "").replace("_", " ")
            break

    defn = str(r.get("definition") or "").strip()
    if len(defn) > 400:
        defn = defn[:397] + "..."

    rows.append({
        "mondo": str(r.get("id") or ""),
        "name": str(r.get("name") or "").strip(),
        "synonyms": syns,
        "orpha": orpha,
        "group": group,
        "specialty": specialty,
        "definition": defn,
        "rare": bool(r.get("is_orphanet_disorder") or r.get("is_orphanet_subtype")),
    })

limit = ${limit || 0}
if limit > 0:
    rows = rows[:limit]

print(json.dumps(rows))
`;

console.log('Downloading Every Cure disease list…');
fs.mkdirSync(path.dirname(PARQUET_PATH), { recursive: true });
if (!fs.existsSync(PARQUET_PATH)) {
  const curl = spawnSync('curl', ['-sL', PARQUET_URL, '-o', PARQUET_PATH], { stdio: 'inherit' });
  if (curl.status !== 0) process.exit(1);
}
const proc = spawnSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (proc.status !== 0) {
  console.error(proc.stderr || proc.stdout);
  process.exit(1);
}

const diseases = JSON.parse(proc.stdout);
const seenSlugs = new Set();
for (const d of diseases) {
  let slug = slugFromCondition(d.name);
  if (seenSlugs.has(slug)) slug = `${slug}-${d.mondo.replace(':', '-').toLowerCase()}`;
  seenSlugs.add(slug);
  d.slug = slug;
}

const out = {
  version: 'everycure-matrix',
  source: 'https://huggingface.co/datasets/everycure/disease-list',
  license: 'CC-BY-4.0',
  attribution: 'Every Cure / Mondo disease ontology — drug-targetable disease filter',
  builtAt: new Date().toISOString(),
  filter: includeAll ? 'all' : 'official_matrix_filter',
  count: diseases.length,
  diseases
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const mb = (fs.statSync(OUT).size / (1024 * 1024)).toFixed(2);
console.log(`Wrote ${diseases.length} diseases → ${OUT} (${mb} MB)`);
