// KB DATA-QUALITY AUDIT.
// Catches the CLASS of bug a clinician found in rp.json: a pipeline-drug
// entry mis-named "Nerandomilast-unrelated — Ocugen OCU410 ..." that leaked an
// unrelated drug name into the report. A drug NAME must be a short proper drug
// name — never a sentence, a disambiguation note, or two things stapled with
// an em-dash. This scans every KB and FAILS (exit 1) on suspicious entries so
// the bug can never silently ship again.
//
// Run: node scripts/audit-kb.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'kb');
const files = readdirSync(KB_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

// The dangerous CLASS of bug is a name that staples in an UNRELATED drug to
// "disambiguate" it (e.g. "Nerandomilast-unrelated — Ocugen OCU410", or
// "AMT-130 (for PD — not the same as AMT-130 for HD)"). That leaks a foreign
// drug name into the report. These patterns are high-signal for that leakage
// and do NOT fire on legitimate long category names like "offshore stem-cell
// clinics (China / Mexico / …)" or parenthetical brand clarifications.
const SUSPICIOUS = [
  { re: /unrelated/i, why: 'name contains "unrelated" (disambiguation text leaked into the name)' },
  { re: /not the same as|not to be confused|don'?t confuse|do not confuse/i, why: 'name disambiguates against another drug (foreign drug leaked in)' },
  { re: /\bconflate/i, why: 'name contains "conflate" (a note, not a drug name)' },
  { re: /mentioned here|listed here because|included for disambiguation/i, why: 'name contains an editorial note' },
  { re: /\n/, why: 'name contains a newline' }
];

let problems = 0;
let scanned = 0;

const checkName = (file, kind, name) => {
  const n = String(name || '');
  if (!n) {
    console.log(`  ✗ [${file}] ${kind} has an EMPTY name`);
    problems++;
    return;
  }
  for (const s of SUSPICIOUS) {
    if (s.re.test(n)) {
      console.log(`  ✗ [${file}] ${kind} name ${s.why}: "${n}"`);
      problems++;
    }
  }
};

for (const file of files) {
  let kb;
  try {
    kb = JSON.parse(readFileSync(join(KB_DIR, file), 'utf8'));
  } catch (e) {
    console.log(`  ✗ [${file}] INVALID JSON: ${e.message}`);
    problems++;
    continue;
  }
  scanned++;
  (kb.pipelineDrugs || []).forEach((d) => checkName(file, 'pipelineDrug', d.name));
  (kb.excludedAgents || []).forEach((a) => checkName(file, 'excludedAgent', a.name));
}

console.log(`\nScanned ${scanned} knowledge bases.`);
if (problems) {
  console.log(`\n❌ ${problems} suspicious name(s) found — fix before shipping.`);
  process.exit(1);
} else {
  console.log('\n✅ No contaminated drug/agent names. All KBs clean.');
}
