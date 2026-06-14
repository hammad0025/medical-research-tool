// Diagnostic: reproduce the FRONTEND repurpose flow against the real
// pipeline (no Vercel timeout) so we can see exactly why only ~3 candidates
// come back, whether they carry links, and how metformin is labelled.
//
// Run: node --env-file=.env.local scripts/diag-repurpose.mjs "Idiopathic Pulmonary Fibrosis"

import handler from '../api/research.js';
import { loadKb } from '../lib/kb.js';

const PASSCODE = (process.env.MRT_ACCESS_PASSCODE || '').split(',')[0] || '';
const condition = process.argv[2] || 'Idiopathic Pulmonary Fibrosis';
const DUMP = process.argv.includes('--dump');

// Build an evidence object straight from the curated KB so we can test the
// SYNTHESIS lanes without the external evidence fetch (sandbox can't reach
// PubMed). This mirrors what evidence.js produces in production.
async function kbEvidence(cond) {
  const kb = await loadKb(cond);
  if (!kb.matched) return null;
  const grounded = (kb.items || []).map((it) => ({
    title: it.title, url: it.url, tier: it.tier, journalTier: it.tier,
    accessLevel: it.accessLevel, isCuratedKB: true, kbCategory: it.category,
    journal: it.journal, year: it.year, sources: ['CuratedKB'], citations: 0,
    text: it.abstract || it.summary || ''
  }));
  return {
    totalUnique: grounded.length, uniqueJournals: grounded.length,
    groundedForPrompt: grounded, topRanked: grounded,
    knowledgeBase: { matched: true, slug: kb.meta.slug },
    pipelineDrugs: kb.meta.pipelineDrugs, excludedAgents: kb.meta.excludedAgents,
    canonicalFacts: kb.meta.canonicalFacts, fdaLabels: [], fdaManufacturers: [],
    promptPackBreakdown: { total: grounded.length }
  };
}

const patient = {
  condition,
  age: '62', sex: 'male', weight: '', height: '',
  medications: '', allergies: '', comorbidities: '', stage: '', goals: ''
};

function invoke(body) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-passcode': PASSCODE },
      body, query: {}
    };
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(obj) { resolve({ status: this.statusCode, body: obj }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; }
    };
    handler(req, res).catch(reject);
  });
}

const textOf = (r) => (r?.body?.content || r?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Mirror the frontend parseCandidates / link extraction roughly.
const REPURPOSE_KEYS = ['CANDIDATE:', 'CLASS:', 'APPROVED_FOR:', 'WHAT_IT_DOES:', 'WHY_FOR_THIS_CONDITION:', 'MECHANISM_TARGET:', 'REPURPOSE_RATIONALE:', 'EVIDENCE_STRENGTH:', 'SUPPORTING_EVIDENCE:', 'REFERENCES:', 'EFFICACY_HYPOTHESIS:', 'SAFETY:', 'CONFIDENCE:', 'PATIENT_SPECIFIC_RISKS:', 'HOW_TO_DISCUSS_WITH_DOCTOR:'];
function parseCandidates(text) {
  const out = []; const lines = text.split('\n'); let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const key = REPURPOSE_KEYS.find(k => t.startsWith(k));
    if (!key) return;
    if (key === 'CANDIDATE:') { if (cur) out.push(cur); cur = {}; }
    if (!cur) return;
    const field = key.replace(':', '').toLowerCase();
    let val = t.slice(key.length).trim(); let n = i + 1;
    while (n < lines.length) { const tt = lines[n].trim(); if (REPURPOSE_KEYS.some(k => tt.startsWith(k)) || tt.startsWith('## ')) break; if (tt) val += ' ' + tt; n++; }
    cur[field] = val;
  });
  if (cur) out.push(cur);
  return out;
}
const hasLink = (s) => /\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/|NCT\d{8}|PMID|10\.\d{4,}/i.test(s || '');

(async () => {
  console.log(`\n=== DIAG repurpose: ${condition} ===  passcode set: ${PASSCODE ? 'yes' : 'NO'}\n`);

  let evidence;
  if (process.argv.includes('--gather')) {
    // Exercise the REAL gather path. Locally PubMed is unreachable, so this
    // proves the KB-only fallback kicks in and grounds the synthesis.
    console.time('gather');
    const g = await invoke({ mode: 'repurpose', patient, audience: 'layperson', phase: 'gather' });
    console.timeEnd('gather');
    evidence = g.body?.evidence;
    console.log('GATHER evidence: grounded', evidence?.groundedForPrompt?.length, '| excludedAgents', evidence?.excludedAgents?.length, '| KB degraded:', evidence?.knowledgeBase?.degraded);
  } else {
    evidence = await kbEvidence(condition);
    console.log('INJECTED KB evidence: items', evidence?.totalUnique, '| pipelineDrugs', evidence?.pipelineDrugs?.length, '| excludedAgents', evidence?.excludedAgents?.length);
  }
  if (!evidence || !(evidence.groundedForPrompt || []).length) { console.log('No usable evidence — cannot continue.'); return; }

  const synthArgs = { mode: 'repurpose', patient, audience: 'layperson', phase: 'synthesize',
    providedDossier: null, providedEvidence: evidence, providedTrials: null };

  console.time('lanes');
  const LANES = 4, PER = 4;
  const calls = [];
  for (let lane = 0; lane < LANES; lane++) calls.push(invoke({ ...synthArgs, half: 'front', batchLane: lane, batchSize: PER }));
  const settled = await Promise.allSettled(calls);
  console.timeEnd('lanes');

  let allText = '';
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled') { console.log(`LANE ${i}: REJECTED ${s.reason?.message}`); return; }
    if (s.value.status !== 200) { console.log(`LANE ${i}: HTTP ${s.value.status} ${JSON.stringify(s.value.body).slice(0,200)}`); return; }
    if (DUMP && i === 0) {
      console.log('BODY KEYS:', Object.keys(s.value.body).join(', '));
      console.log('content type:', typeof s.value.body.content, Array.isArray(s.value.body.content));
      console.log('top-level .text len:', (s.value.body.text || '').length, '| .analysis len:', (s.value.body.analysis || '').length);
    }
    const txt = textOf(s.value) || s.value.body.text || s.value.body.analysis || '';
    const cands = parseCandidates(txt);
    const withLinks = cands.filter(c => hasLink(c.references) || hasLink(c.supporting_evidence)).length;
    console.log(`LANE ${i}: ${cands.length} candidates, ${withLinks} with links | stop=${s.value.body.stop_reason || s.value.body.stopReason || '?'} | out_tok=${s.value.body.usage?.output_tokens}`);
    cands.forEach(c => console.log(`   - ${c.candidate || '(no name)'} | ev=${c.evidence_strength || '?'} | refs:${hasLink(c.references) ? 'Y' : 'n'}`));
    if (DUMP && i === 3) console.log('\n--- RAW LANE D (first 1400 chars) ---\n' + txt.slice(0, 1400) + '\n--- end ---\n');
    if (DUMP && cands.length === 0) console.log(`\n--- RAW LANE ${i} (first 900 chars, 0 parsed) ---\n` + txt.slice(0, 900) + '\n--- end ---\n');
    allText += '\n' + txt;
  });

  const all = parseCandidates(allText);
  console.log(`\nTOTAL parsed candidates (pre-dedup): ${all.length}`);
  const metformin = all.filter(c => /metformin/i.test(c.candidate || ''));
  metformin.forEach(c => console.log(`METFORMIN → ev=${c.evidence_strength} | why="${(c.why_for_this_condition||'').slice(0,160)}"`));
  if (/not (yet )?studied|never (been )?studied|unexplored|no research/i.test(allText)) {
    console.log('\n⚠️  Output contains a "not studied / no research" phrase. Context:');
    const m = allText.match(/.{80}(not (yet )?studied|never (been )?studied|unexplored|no research).{80}/i);
    if (m) console.log('   …' + m[0].replace(/\n/g, ' ') + '…');
  }
})();
