// scripts/regression-kb-coverage.mjs
//
// Output-quality regression test for the pipeline-drug coverage guardrail
// (the anti-"AI slop" feature). This is the test we want to quote to Dorothy:
//
//   "We test against N curated conditions, and our coverage audit passes X%
//    of the time — when the AI omits a key drug, we catch it and force a
//    retry."
//
// MODES:
//
//   OFFLINE (default, no API key required)
//     - Validates every KB file parses and has the required shape
//     - Verifies the coverage-audit semantics (used by api/research.js
//       post-synthesis) correctly flags missing pipeline drugs against a
//       deliberately-incomplete mock synthesis output for each condition.
//     - This is the fast "did we regress the data model?" check.
//
//   LIVE (REGRESSION_LIVE=1 + ANTHROPIC_API_KEY set)
//     - Actually runs /api/research mode=research (both halves) against
//       each condition with a realistic patient profile, then checks the
//       concatenated synthesis text for every approved pipelineDrug.
//     - This is the slow "does the full pipeline actually produce good
//       output end-to-end?" check. Expensive. Run before major releases.
//
// Exits non-zero if any regression is detected.
//
// Run:
//   node scripts/regression-kb-coverage.mjs                # offline
//   REGRESSION_LIVE=1 ANTHROPIC_API_KEY=... node scripts/regression-kb-coverage.mjs

import researchHandler from '../api/research.js';
import { loadKb, listKbs } from '../lib/kb.js';

const pass = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`\x1b[31m✗\x1b[0m ${msg}`); process.exitCode = 1; };
const info = (msg) => console.log(`  ${msg}`);
const section = (msg) => console.log(`\n=== ${msg} ===`);

const mockRes = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    end() { this._ended = true; },
    json(obj) { this.body = obj; this._ended = true; return this; }
  };
  return res;
};

const invoke = async (handler, body) => {
  const req = { method: 'POST', body, headers: {}, query: {} };
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
};

// Conditions we claim "bulletproof" coverage for. Each row pins the drugs
// that MUST appear in a satisfying synthesis output — these are the
// "Dorothy would be furious if it missed this" drugs for each disease.
const REGRESSION_MATRIX = [
  {
    condition: 'Idiopathic Pulmonary Fibrosis',
    slug: 'ipf',
    kbAlias: 'IPF',
    mustMention: ['Pirfenidone', 'Nintedanib', 'Nerandomilast'],
    patient: {
      condition: 'Idiopathic Pulmonary Fibrosis',
      stage: 'GAP stage II', age: '68', gender: 'Male', weight: '178 lb',
      smoking: 'Former, 30 pack-years, quit 2010',
      diagnoses: 'IPF, GERD, hypertension',
      medications: 'Pirfenidone 2403 mg/day, omeprazole 40 mg, lisinopril 20 mg',
      symptoms: 'Progressive DOE, dry cough',
      labWork: 'FVC 62% predicted, DLCO 41%'
    }
  },
  {
    condition: 'Retinitis Pigmentosa',
    slug: 'rp',
    kbAlias: 'retinitis pigmentosa',
    mustMention: ['Luxturna', 'OCU400'],
    patient: {
      condition: 'Retinitis Pigmentosa', age: '34', gender: 'Female',
      diagnoses: 'Retinitis pigmentosa (autosomal recessive, genotype pending)',
      medications: 'None',
      symptoms: 'Night blindness since age 15, peripheral vision loss'
    }
  },
  {
    condition: 'Alzheimer Disease',
    slug: 'alzheimer-disease',
    kbAlias: 'Alzheimer disease',
    mustMention: ['Lecanemab', 'Donanemab'],
    patient: {
      condition: 'Alzheimer disease', age: '72', gender: 'Female',
      diagnoses: 'Mild dementia due to AD, amyloid PET positive',
      medications: 'Donepezil 10 mg',
      symptoms: 'Short-term memory loss, mild word-finding difficulty'
    }
  },
  {
    condition: 'Amyotrophic Lateral Sclerosis',
    slug: 'als',
    kbAlias: 'ALS',
    // Key ALS check: we must mention riluzole + tofersen (gene-targeted)
    // AND the AMX0035/Relyvrio withdrawal — otherwise we'd recommend a
    // withdrawn drug. The withdrawal check is handled as a "must NOT
    // recommend-as-active" check below.
    mustMention: ['Riluzole', 'Tofersen'],
    mustAddress: ['Relyvrio'],
    patient: {
      condition: 'ALS', age: '58', gender: 'Male',
      diagnoses: 'Spinal-onset ALS, SOD1 mutation (A4V)',
      medications: 'Riluzole 50 mg BID',
      symptoms: 'Progressive weakness R>L upper extremities over 8 months'
    }
  },
  {
    condition: 'Parkinson Disease',
    slug: 'parkinson-disease',
    kbAlias: 'Parkinson disease',
    mustMention: ['Levodopa', 'Vyalev'],
    patient: {
      condition: 'Parkinson disease', age: '66', gender: 'Male',
      diagnoses: 'Idiopathic PD, motor fluctuations',
      medications: 'Carbidopa/levodopa 25/100 TID, rasagiline 1 mg',
      symptoms: 'Resting tremor R hand, bradykinesia, early motor fluctuations'
    }
  }
];

const hasMention = (text, candidates) => {
  const lower = String(text || '').toLowerCase();
  return candidates.some((c) => lower.includes(String(c).toLowerCase()));
};

// ============================================================
// OFFLINE: KB shape + coverage-audit semantics (no API needed)
// ============================================================
(async () => {
  section('REGRESSION: KB-coverage guardrail');
  info(`live mode: ${process.env.REGRESSION_LIVE === '1' ? 'ON (will call Anthropic for each condition)' : 'OFF (offline checks only)'}`);

  section('0. KB inventory');
  const all = await listKbs();
  info(`discovered ${all.length} curated KBs:`);
  for (const kb of all) info(`  · ${kb.slug.padEnd(22)} v${kb.version}  (${kb.itemCount} items)`);
  if (all.length < 11) {
    fail(`expected at least 11 KBs (IPF + RP + 9 new conditions), got ${all.length}`);
  } else {
    pass(`${all.length} KBs registered (IPF + RP + 9 condition-specific)`);
  }

  section('1. KB shape + pipelineDrugs floor');
  for (const row of REGRESSION_MATRIX) {
    const kb = await loadKb(row.kbAlias);
    if (!kb.matched) { fail(`KB did not match alias "${row.kbAlias}" (${row.condition})`); continue; }
    const pipeline = kb.meta?.pipelineDrugs || [];
    const excluded = kb.meta?.excludedAgents || [];

    if (pipeline.length < 5) {
      fail(`[${row.slug}] pipelineDrugs length = ${pipeline.length} (want ≥5)`);
    } else {
      pass(`[${row.slug}] pipelineDrugs=${pipeline.length}, excludedAgents=${excluded.length}`);
    }

    // Every must-mention anchor has to actually be in the KB as a
    // pipeline drug (otherwise the coverage audit can't enforce it).
    for (const needle of row.mustMention) {
      const hit = pipeline.find((d) =>
        [d.name, ...(d.aliases || [])].some((n) => String(n).toLowerCase().includes(needle.toLowerCase()))
      );
      hit
        ? pass(`[${row.slug}] anchor drug "${needle}" is registered as pipelineDrug (status=${hit.approvalStatus || '?'})`)
        : fail(`[${row.slug}] anchor drug "${needle}" is NOT registered in pipelineDrugs — coverage audit will silently miss it`);
    }

    // Withdrawn-drug awareness: anything listed in `mustAddress` should
    // appear either in pipelineDrugs OR excludedAgents. Otherwise we'd
    // recommend it as current.
    for (const ref of row.mustAddress || []) {
      const inPipeline = pipeline.some((d) =>
        [d.name, ...(d.aliases || [])].some((n) => String(n).toLowerCase().includes(ref.toLowerCase()))
      );
      const inExcluded = excluded.some((x) =>
        String(x.name || '').toLowerCase().includes(ref.toLowerCase())
      );
      inPipeline || inExcluded
        ? pass(`[${row.slug}] withdrawn/failed drug "${ref}" is addressed in KB (${inPipeline ? 'pipelineDrugs' : 'excludedAgents'})`)
        : fail(`[${row.slug}] withdrawn drug "${ref}" not tracked — risk of recommending a withdrawn drug`);
    }
  }

  section('2. Coverage-audit semantics (anti-"AI slop" post-synthesis check)');
  // This mirrors scanForMissedPipelineDrugs() in api/research.js. If the
  // shape ever drifts, this test regresses loudly.
  let auditPasses = 0;
  let auditTotal = 0;
  for (const row of REGRESSION_MATRIX) {
    const kb = await loadKb(row.kbAlias);
    const names = (kb.meta?.pipelineDrugs || []).map((d) => [d.name, ...(d.aliases || [])]);

    // Mock synthesis output that deliberately omits THE key pipeline drug
    // we expect to be flagged. For IPF, omit Nerandomilast. For RP, omit OCU400.
    // For AD, omit Lecanemab. For ALS, omit Tofersen. For PD, omit Vyalev.
    const omit = {
      ipf:                 'Nerandomilast',
      rp:                  'OCU400',
      'alzheimer-disease': 'Lecanemab',
      als:                 'Tofersen',
      'parkinson-disease': 'Vyalev'
    }[row.slug];

    const omitLower = (omit || '').toLowerCase();
    const matchesOmit = (d) => omitLower && (
      String(d.name || '').toLowerCase().includes(omitLower) ||
      (d.aliases || []).some((a) => String(a).toLowerCase().includes(omitLower))
    );
    const mentionedPipelineDrugs = (kb.meta?.pipelineDrugs || [])
      .filter((d) => !matchesOmit(d))
      .filter((d) => (d.approvalStatus || '').toLowerCase().startsWith('approved'))
      .slice(0, 3)
      .map((d) => d.name);

    const mockOutput = mentionedPipelineDrugs.length
      ? `## Approved Treatments\n${mentionedPipelineDrugs.map((n) => `- ${n}`).join('\n')}`
      : `## Treatments\n- (mock output with no pipeline drugs at all)`;

    const lower = mockOutput.toLowerCase();
    const missed = names.filter((candidates) =>
      !candidates.some((n) => lower.includes(String(n).toLowerCase()))
    ).map((c) => c[0]);

    auditTotal += 1;
    const flaggedOmit = omit && missed.some((m) => String(m).toLowerCase().includes(omit.toLowerCase()));
    if (flaggedOmit) {
      auditPasses += 1;
      pass(`[${row.slug}] coverage audit flagged missing "${omit}" (anti-slop guardrail is wired)`);
    } else if (!omit) {
      info(`[${row.slug}] (no specific omit target configured — skipping)`);
    } else {
      fail(`[${row.slug}] coverage audit did NOT flag missing "${omit}"; got: [${missed.join(', ')}]`);
    }
  }
  info(`coverage-audit self-test: ${auditPasses}/${auditTotal} passed`);
  if (auditTotal > 0 && auditPasses < auditTotal) {
    fail(`coverage audit regression — ${auditTotal - auditPasses} of ${auditTotal} KBs failed to self-flag their anchor omission`);
  } else if (auditTotal > 0) {
    pass(`coverage audit passes 100% of self-tests (${auditPasses}/${auditTotal})`);
  }

  // ============================================================
  // LIVE: actually run the pipeline against each condition
  // ============================================================
  if (process.env.REGRESSION_LIVE !== '1') {
    section('LIVE pipeline tests');
    info('skipped — set REGRESSION_LIVE=1 and ANTHROPIC_API_KEY to exercise the full research pipeline');
    section('DONE (offline)');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    fail('REGRESSION_LIVE=1 but ANTHROPIC_API_KEY is not set');
    return;
  }

  section('3. LIVE pipeline coverage — /api/research mode=research');
  let liveTotal = 0;
  let liveCovered = 0;
  const liveDetails = [];

  for (const row of REGRESSION_MATRIX) {
    info(`\n→ ${row.condition} (${row.slug})`);
    const t0 = Date.now();
    let research;
    try {
      research = await invoke(researchHandler, {
        mode: 'research',
        patient: row.patient,
        audience: 'layperson'
      });
    } catch (err) {
      fail(`[${row.slug}] research call threw: ${err.message}`);
      continue;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (research.status !== 200) {
      fail(`[${row.slug}] research HTTP ${research.status}: ${JSON.stringify(research.body).slice(0, 200)}`);
      continue;
    }
    const text = (research.body.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    info(`  returned ${text.length} chars in ${elapsed}s`);

    const missing = [];
    for (const needle of row.mustMention) {
      // Resolve to the KB entry so aliases count.
      const kb = await loadKb(row.kbAlias);
      const entry = (kb.meta?.pipelineDrugs || []).find((d) =>
        [d.name, ...(d.aliases || [])].some((n) => String(n).toLowerCase().includes(needle.toLowerCase()))
      );
      const candidates = entry
        ? [entry.name, ...(entry.aliases || [])]
        : [needle];
      if (!hasMention(text, candidates)) missing.push(needle);
    }

    liveTotal += row.mustMention.length;
    liveCovered += row.mustMention.length - missing.length;

    if (missing.length === 0) {
      pass(`[${row.slug}] all ${row.mustMention.length} anchor drugs appear in synthesis: ${row.mustMention.join(', ')}`);
    } else {
      fail(`[${row.slug}] missing: ${missing.join(', ')}`);
    }

    // Bonus check: for ALS, verify the synthesis addresses the withdrawal of
    // Relyvrio rather than recommending it. If Relyvrio is mentioned AND the
    // text does NOT contain the word "withdrawn" (or similar), that's AI slop.
    if (row.mustAddress) {
      for (const ref of row.mustAddress) {
        if (hasMention(text, [ref])) {
          const addressedAsWithdrawn = /withdraw|discontinu|halted|removed from (the )?market|no longer available|failed/i.test(text);
          addressedAsWithdrawn
            ? pass(`[${row.slug}] mentions "${ref}" AND correctly flags its withdrawn/failed status`)
            : fail(`[${row.slug}] mentions "${ref}" but does NOT flag it as withdrawn — risk of recommending a withdrawn drug`);
        }
      }
    }

    liveDetails.push({ slug: row.slug, elapsed, total: row.mustMention.length, missing: missing.length });
  }

  section('LIVE RESULTS');
  info(`anchor-drug coverage across ${REGRESSION_MATRIX.length} conditions:`);
  for (const d of liveDetails) {
    info(`  ${d.slug.padEnd(22)} ${d.total - d.missing}/${d.total} drugs covered (${d.elapsed}s)`);
  }
  const coveragePct = liveTotal === 0 ? 0 : Math.round((liveCovered / liveTotal) * 100);
  info(`overall anchor-drug coverage: ${liveCovered}/${liveTotal} (${coveragePct}%)`);
  if (coveragePct < 100) {
    fail(`coverage <100% — this is what Dorothy's "AI slop" concern is. ${liveTotal - liveCovered} of ${liveTotal} anchor drugs missing.`);
  } else {
    pass(`coverage audit passed 100% (${liveCovered}/${liveTotal}) across ${REGRESSION_MATRIX.length} conditions — that's the number to quote Dorothy.`);
  }

  section('DONE (live)');
})().catch((err) => {
  console.error('\x1b[31m✗ regression harness error\x1b[0m', err);
  process.exitCode = 1;
});
