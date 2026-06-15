#!/usr/bin/env node
// Build data/drug-registry.json from the open curated drug library (CC-BY-4.0).
// Source: https://huggingface.co/datasets/everycure/drug-list
//
// Usage: node scripts/build-drug-registry.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'drug-registry.json');
const PARQUET_URL =
  'https://huggingface.co/api/datasets/everycure/drug-list/parquet/default/train/0.parquet';
const PARQUET_PATH = path.join(ROOT, 'data', '.cache', 'ec-drug-list.parquet');

const py = `
import json, sys
try:
    import pyarrow.parquet as pq
except ImportError:
    print("Install pyarrow: pip3 install pyarrow", file=sys.stderr)
    sys.exit(1)

df = pq.read_table(${JSON.stringify(PARQUET_PATH)}).to_pandas()
rows = []
for _, r in df.iterrows():
    syns = r.get("synonyms")
    if syns is None or (isinstance(syns, float) and syns != syns):
        syns = []
    elif hasattr(syns, "tolist"):
        syns = syns.tolist()
    elif isinstance(syns, str):
        syns = [s.strip() for s in syns.split(";") if s.strip()]
    syns = [str(s).strip() for s in syns if str(s).strip()][:12]

    approved = str(r.get("approved_usa") or "").upper() == "APPROVED"
    rows.append({
        "id": str(r.get("id") or ""),
        "name": str(r.get("name") or "").strip(),
        "synonyms": syns,
        "drugClass": str(r.get("drug_class") or "").strip(),
        "therapeuticArea": str(r.get("therapeutic_area") or "").strip(),
        "drugFunction": str(r.get("drug_function") or "").strip(),
        "drugTarget": str(r.get("drug_target") or "").strip(),
        "approvedUsa": approved,
        "atcL2": str(r.get("l2_label") or "").strip(),
        "flags": {
            "antipsychotic": bool(r.get("is_antipsychotic")),
            "sedative": bool(r.get("is_sedative")),
            "antimicrobial": bool(r.get("is_antimicrobial")),
            "glucoseRegulator": bool(r.get("is_glucose_regulator")),
            "chemotherapy": bool(r.get("is_chemotherapy")),
            "steroid": bool(r.get("is_steroid")),
            "analgesic": bool(r.get("is_analgesic")),
            "cardiovascular": bool(r.get("is_cardiovascular")),
            "cellTherapy": bool(r.get("is_cell_therapy"))
        }
    })

print(json.dumps(rows))
`;

console.log('Downloading curated drug library…');
fs.mkdirSync(path.dirname(PARQUET_PATH), { recursive: true });
if (!fs.existsSync(PARQUET_PATH)) {
  const curl = spawnSync('curl', ['-sL', PARQUET_URL, '-o', PARQUET_PATH], { stdio: 'inherit' });
  if (curl.status !== 0) process.exit(1);
}

const proc = spawnSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (proc.status !== 0) {
  console.error(proc.stderr || proc.stdout);
  process.exit(1);
}

const drugs = JSON.parse(proc.stdout).filter((d) => d.name);
const out = {
  version: 'curated-drug-library-v1',
  source: 'https://huggingface.co/datasets/everycure/drug-list',
  license: 'CC-BY-4.0',
  attribution: 'Curated drug library (NCATS Translator / open biomedical sources)',
  builtAt: new Date().toISOString(),
  count: drugs.length,
  approvedCount: drugs.filter((d) => d.approvedUsa).length,
  drugs
};

fs.writeFileSync(OUT, JSON.stringify(out));
const mb = (fs.statSync(OUT).size / (1024 * 1024)).toFixed(2);
console.log(`Wrote ${drugs.length} drugs → ${OUT} (${mb} MB)`);
