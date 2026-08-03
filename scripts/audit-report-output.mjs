// Generate real reports and lint what a reader would see.
//
// The test suite covers this with fixtures so it stays fast and offline; this
// script does the same checks against live output, which is the only thing that
// catches a defect nobody thought to write a fixture for. Every defect it
// checks for shipped to a real user, because the change that caused it was
// verified at the layer it touched instead of on the page.
//
//   node scripts/audit-report-output.mjs                       # default set
//   node scripts/audit-report-output.mjs "Asthma" "Epilepsy"   # named conditions
//
// Requires ANTHROPIC_API_KEY (and PERPLEXITY_API_KEY for the enrichment
// sections). Exits non-zero when any report has a defect.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { lintReport, lintIdeaSections } from '../lib/report-lint.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env.local the way `vercel dev` does, so the script works locally.
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.MRT_DISABLE_USAGE_LIMIT = '1';

const researchHandler = (await import('../api/research.js')).default;
const { resolveRepurposeSection, candidateDedupKey } =
  await import('../lib/repurpose-quality.js');

const DEFAULT_CONDITIONS = ['Retinitis Pigmentosa', 'Idiopathic Pulmonary Fibrosis', 'Asthma'];

const call = async (body, tag) => {
  const res = {
    _s: 200, _j: null,
    status(code) { this._s = code; return this; },
    json(payload) { this._j = payload; return this; },
    setHeader() {}, end() {}
  };
  const key = `audit-${tag}-${process.pid}`;
  await researchHandler({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idempotency-key': key },
    body: { ...body, idempotencyKey: key },
    query: {}
  }, res);
  return { status: res._s, body: res._j };
};

const textOf = (payload) =>
  (payload?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const auditCondition = async (condition) => {
  const patient = { condition };
  const gathered = await call(
    { mode: 'research', patient, audience: 'layperson', phase: 'gather' },
    `g-${condition}`
  );
  if (!gathered.body?.evidence) {
    return { condition, fatal: `gather failed (HTTP ${gathered.status})` };
  }
  const base = {
    patient,
    audience: 'layperson',
    phase: 'synthesize',
    gatherSeal: gathered.body.gatherSeal,
    gatherFingerprint: gathered.body.gatherFingerprint,
    providedDossier: gathered.body.dossier
      ? { ...gathered.body.dossier, poolsFingerprint: gathered.body.gatherFingerprint }
      : null,
    providedEvidence: gathered.body.evidence,
    providedTrials: gathered.body.trials
  };

  const front = await call({ ...base, mode: 'research', half: 'front' }, `f-${condition}`);
  const back = await call(
    { ...base, mode: 'research', half: 'back', priorText: textOf(front.body) },
    `b-${condition}`
  );
  const report = [textOf(front.body), textOf(back.body)].filter(Boolean).join('\n\n');
  const reportLint = lintReport(report);

  // Idea sections, from the lanes the browser runs.
  const { REPURPOSE_LANE_COUNT, REPURPOSE_PER_LANE, REPURPOSE_SECTION_DISPLAY_CAP,
    REPURPOSE_RESEARCHED_LANE, REPURPOSE_MECHANISTIC_LANE } =
    await import('../lib/repurpose-quality.js');
  const lanes = await Promise.all(
    Array.from({ length: REPURPOSE_LANE_COUNT }, (_, lane) =>
      call({
        ...base,
        mode: 'repurpose',
        half: 'front',
        batchLane: lane,
        batchSize: (lane === REPURPOSE_RESEARCHED_LANE || lane === REPURPOSE_MECHANISTIC_LANE)
          ? REPURPOSE_SECTION_DISPLAY_CAP
          : REPURPOSE_PER_LANE
      }, `l${lane}-${condition}`).then((r) => textOf(r.body)))
  );
  const seen = new Map();
  for (const laneText of lanes) {
    for (const block of String(laneText).split(/(?=^(?:CANDIDATE|Drug or supplement idea):\s)/gim)) {
      if (!/^(?:CANDIDATE|Drug or supplement idea):/im.test(block)) continue;
      const name = (block.match(/^(?:CANDIDATE|Drug or supplement idea):\s*(.+)$/im) || [])[1];
      const key = candidateDedupKey(name);
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        name: String(name).trim(),
        section: resolveRepurposeSection(block, {
          condition,
          hasCitation: /https?:\/\//.test(block)
        })
      });
    }
  }
  const all = [...seen.values()];
  const ideaLint = lintIdeaSections({
    researched: all.filter((c) => c.section === 'researched-not-approved').map((c) => c.name),
    notStudied: all.filter((c) => c.section === 'no-condition-study-identified').map((c) => c.name)
  });

  return {
    condition,
    sections: reportLint.sections,
    defects: [...reportLint.defects, ...ideaLint.defects],
    ideas: {
      researched: all.filter((c) => c.section === 'researched-not-approved').length,
      notStudied: all.filter((c) => c.section === 'no-condition-study-identified').length
    }
  };
};

const conditions = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CONDITIONS;
let failed = 0;

for (const condition of conditions) {
  let result;
  try {
    result = await auditCondition(condition);
  } catch (error) {
    console.log(`ERROR ${condition}: ${error.message}`);
    failed += 1;
    continue;
  }
  if (result.fatal) {
    console.log(`ERROR ${condition}: ${result.fatal}`);
    failed += 1;
    continue;
  }
  const ok = result.defects.length === 0;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${condition.padEnd(32)} ` +
    `sections ${result.sections.found - result.sections.empty.length}/${result.sections.found}  ` +
    `ideas ${result.ideas.researched}+${result.ideas.notStudied}  ` +
    `defects ${result.defects.length}`
  );
  for (const defect of result.defects.slice(0, 8)) {
    console.log(`        ${defect.id}: ${defect.describe}${defect.sample ? ` — ${defect.sample}` : ''}`);
  }
}

console.log(failed ? `\n${failed} of ${conditions.length} condition(s) have defects.` : `\nAll ${conditions.length} clean.`);
process.exit(failed ? 1 : 0);
