#!/usr/bin/env node
// Golden-output regression for the report parsers + the loud leak-detector
// invariant (Layer 1 + Layer 2). Offline, no Anthropic spend.
// Run: node scripts/regression-report-parsers.mjs
//
// Feeds REAL representative model outputs (scripts/fixtures/report-outputs/),
// including the messy formats that shipped the AGA "Male Pattern Baldness"
// defects, through the ACTUAL parser logic and the SHARED leak detector
// (lib/report-polish.js detectStructuralLeak / auditCardFields). It proves both
// directions:
//   BEFORE — the pre-fix parser logic leaves residual structural tokens in card
//            fields and the leak detector FLAGS them (the defect would ship).
//   AFTER  — the hardened parsers produce clean structured cards, the leak
//            detector finds NOTHING, there is no raw-blob fallback, and no
//            half-truncated card renders.
//
// The fixed parsers below are a faithful port of the index.html parsers (the
// file is a no-build static page and cannot import modules); the leak detector,
// percent, and sentence-clamp helpers are the REAL shared code from
// lib/report-polish.js, so a future drift there fails this suite.

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  detectStructuralLeak,
  auditCardFields,
  parseHeadlinePercent,
  clampToCompleteSentence,
  drugKeysMatch,
  renderInlineMarkdownHtml,
  cleanAnchorLabel,
  filterExcludedAgentMentions
} from '../lib/report-polish.js';

const pass = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, 'fixtures', 'report-outputs');
const fx = (name) => readFileSync(path.join(FIX_DIR, name), 'utf8');

console.log('\n=== Report-parser golden-output regression (Layer 1 + 2) ===');

// ---------------------------------------------------------------------------
// Shared block walkers — FIXED (hardened) and LEGACY (pre-fix) variants.
// ---------------------------------------------------------------------------
const CARD_BOUNDARY_RE = /^(?:-{2,}\s*)?(?:#{1,6}\s*)?(?:💊\s*)?(?:(?:drug|treatment|combo|combination|candidate|supplement)\s+)?CARD\s+\d+\s*[—–:-]/i;
const isCardBoundaryLine = (line) => CARD_BOUNDARY_RE.test(String(line || '').trim());

const collectBlock = (text, startIdx, terminators) => {
  const lines = text.split('\n');
  let cur = lines[startIdx].split(':').slice(1).join(':').trim();
  let next = startIdx + 1;
  while (next < lines.length) {
    const trimmed = lines[next].trim();
    if (terminators.some((t) => trimmed.startsWith(t))) break;
    if (trimmed.startsWith('## ')) break;
    if (isCardBoundaryLine(trimmed)) break;
    if (trimmed) cur += ' ' + trimmed;
    next++;
  }
  return cur;
};

// Pre-fix: NO card-boundary break (AGA defect 1) — a card's SOURCES/REFERENCES
// swallowed the next "### 💊 CARD N —" header + its WHAT IT DOES intro.
const collectBlockLegacy = (text, startIdx, terminators) => {
  const lines = text.split('\n');
  let cur = lines[startIdx].split(':').slice(1).join(':').trim();
  let next = startIdx + 1;
  while (next < lines.length) {
    const trimmed = lines[next].trim();
    if (terminators.some((t) => trimmed.startsWith(t))) break;
    if (trimmed.startsWith('## ')) break;
    if (trimmed) cur += ' ' + trimmed;
    next++;
  }
  return cur;
};

// ---------------------------------------------------------------------------
// Approved-treatment cards.
// ---------------------------------------------------------------------------
const TREATMENT_KEYS = [
  'PROVIDER:', 'TREATMENT:', 'FDA_STATUS:', 'LENGTH_FREQUENCY:',
  'EFFICACY:', 'SAFETY:', 'RISKS:', 'INTERACTIONS:', 'COST:', 'REFERENCES:'
];
const parseTreatmentsWith = (text, collector) => {
  const blocks = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const key = TREATMENT_KEYS.find((k) => t.startsWith(k));
    if (!key) return;
    if (key === 'PROVIDER:') { if (cur) blocks.push(cur); cur = { _type: 'treatment' }; }
    if (!cur) return;
    const field = key.replace(':', '').toLowerCase();
    cur[field] = clampToCompleteSentence(collector(text, i, TREATMENT_KEYS));
    if (field === 'efficacy' || field === 'safety') {
      cur[field + '_pct'] = parseHeadlinePercent(cur[field]);
    }
  });
  if (cur) blocks.push(cur);
  // Mirror of index.html: recover a name for a PROVIDER-only card (device
  // entries the model left without a TREATMENT: line) and drop nameless,
  // contentless cards so "(unnamed treatment)" never renders.
  const deriveTreatmentName = (b) => String(b.provider || '')
    .split(/\s*[|—–]\s*/)
    .map((s) => s.trim())
    .find((s) => s
      && !/^\+?[\d().\s-]{7,}$/.test(s)
      && !/^https?:|\.(com|org|gov|net|edu)\b/i.test(s)
      && !/^(ask|call|available|implanted|administered|contact|by )/i.test(s)) || '';
  return blocks
    .map((b) => (b.treatment ? b : { ...b, treatment: deriveTreatmentName(b) }))
    .filter((b) => b.treatment || b.efficacy_pct != null || b.safety_pct != null || b.risks)
    .sort((a, b) => (b.efficacy_pct || 0) - (a.efficacy_pct || 0));
};
const parseTreatments = (text) => parseTreatmentsWith(text, collectBlock);
const parseTreatmentsLegacy = (text) => parseTreatmentsWith(text, collectBlockLegacy);
const TREATMENT_FIELDS = ['treatment', 'fda_status', 'provider', 'references', 'risks', 'efficacy', 'safety'];

// ---------------------------------------------------------------------------
// Repurposing candidate cards.
// ---------------------------------------------------------------------------
const REPURPOSE_KEYS = [
  'CANDIDATE:', 'CLASS:', 'APPROVED_FOR:', 'WHAT_IT_DOES:', 'WHY_FOR_THIS_CONDITION:',
  'MECHANISM_TARGET:', 'REPURPOSE_RATIONALE:', 'EVIDENCE_STRENGTH:', 'SUPPORTING_EVIDENCE:',
  'REFERENCES:', 'EFFICACY_HYPOTHESIS:', 'SAFETY:', 'CONFIDENCE:', 'PATIENT_SPECIFIC_RISKS:',
  'HOW_TO_DISCUSS_WITH_DOCTOR:'
];
const candidateIdentityKey = (name) =>
  String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '').trim();
const candidateSearchTerms = (name) => {
  const raw = String(name || '').replace(/\*/g, '');
  const terms = [];
  const lead = raw.replace(/\(.*?\)/g, ' ').split(/[—–]|\s-\s|:|\|/)[0].replace(/\s+\d.*$/, '').trim();
  if (lead.length >= 4) terms.push(lead);
  const paren = raw.match(/\(([^)]+)\)/);
  if (paren) {
    for (const piece of paren[1].split(/[,/]/)) {
      const p = piece.trim();
      if (p.length >= 4 && !/^\d/.test(p)) terms.push(p);
    }
  }
  return terms;
};
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CANDIDATE_SELF_FIELDS = [
  'patient_specific_risks', 'safety', 'confidence', 'efficacy_hypothesis', 'how_to_discuss_with_doctor'
];
const dropForeignCandidateFields = (cands) => {
  const ident = cands.map((c) => ({ key: candidateIdentityKey(c.candidate), terms: candidateSearchTerms(c.candidate) }));
  cands.forEach((cand, ci) => {
    const self = ident[ci];
    if (!self.key) return;
    const foreign = ident.filter((x, i) => i !== ci && x.key && !drugKeysMatch(x.key, self.key) && x.terms.length);
    if (!foreign.length) return;
    CANDIDATE_SELF_FIELDS.forEach((field) => {
      const val = cand[field];
      if (val == null) return;
      const lower = String(val).toLowerCase();
      if (self.terms.some((t) => lower.includes(t.toLowerCase()))) return;
      const hit = foreign.some((f) => f.terms.some((t) => new RegExp('\\b' + escapeRe(t) + '\\b', 'i').test(String(val))));
      if (hit) delete cand[field];
    });
  });
  return cands;
};
const parseCandidates = (text) => {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const key = REPURPOSE_KEYS.find((k) => t.startsWith(k));
    if (!key) return;
    const field = key.replace(':', '').toLowerCase();
    if (key === 'CANDIDATE:' || (cur && cur[field] !== undefined)) { if (cur) out.push(cur); cur = {}; }
    if (!cur) return;
    cur[field] = collectBlock(text, i, REPURPOSE_KEYS);
    if (field === 'efficacy_hypothesis' || field === 'safety' || field === 'confidence') {
      cur[field + '_pct'] = parseHeadlinePercent(cur[field]);
    }
  });
  if (cur) out.push(cur);
  const sorted = out.sort((a, b) =>
    (b.confidence_pct || b.efficacy_hypothesis_pct || 0) - (a.confidence_pct || a.efficacy_hypothesis_pct || 0));
  const seen = new Set();
  const deduped = [];
  for (const cand of sorted) {
    if (!String(cand.candidate || '').trim()) continue;
    const norm = candidateIdentityKey(cand.candidate);
    if (norm && seen.has(norm)) continue;
    if (norm) seen.add(norm);
    deduped.push(cand);
  }
  return dropForeignCandidateFields(deduped);
};
const CANDIDATE_FIELDS = [
  'candidate', 'class', 'approved_for', 'what_it_does', 'why_for_this_condition',
  'mechanism_target', 'repurpose_rationale', 'evidence_strength', 'supporting_evidence',
  'references', 'efficacy_hypothesis', 'safety', 'confidence', 'patient_specific_risks',
  'how_to_discuss_with_doctor'
];

// ---------------------------------------------------------------------------
// Combination cards — FIXED (normalized labels + truncation drop) and LEGACY
// (exact underscored labels, no truncation drop = AGA defects 2 + 3).
// ---------------------------------------------------------------------------
const COMBO_FIELD_BY_NORM = {
  COMBO: 'combo', RATIONALE: 'rationale', EVIDENCETIER: 'evidence_tier',
  SUPPORTINGEVIDENCE: 'supporting_evidence', INTERACTIONRISK: 'interaction_risk',
  PATIENTSPECIFICRISKS: 'patient_specific_risks', CONFIDENCE: 'confidence',
  HOWTODISCUSSWITHDOCTOR: 'how_to_discuss_with_doctor', REFERENCES: 'references'
};
const comboFieldFromLine = (line) => {
  const t = String(line || '').trim().replace(/\*\*/g, '');
  const m = t.match(/^([A-Za-z][A-Za-z _\-]*?)\s*:/);
  if (!m) return null;
  const norm = m[1].replace(/[^a-z0-9]/gi, '').toUpperCase();
  return COMBO_FIELD_BY_NORM[norm] || null;
};
const collectComboValue = (lines, startIdx) => {
  let cur = lines[startIdx].split(':').slice(1).join(':').replace(/^\s*\*+\s*/, '').trim();
  let next = startIdx + 1;
  while (next < lines.length) {
    const trimmed = lines[next].trim();
    if (comboFieldFromLine(trimmed)) break;
    if (trimmed.startsWith('## ')) break;
    if (isCardBoundaryLine(trimmed)) break;
    if (trimmed) cur += ' ' + trimmed;
    next++;
  }
  return cur;
};
const COMBO_TRAILING_FIELDS = ['interaction_risk', 'patient_specific_risks', 'confidence', 'how_to_discuss_with_doctor', 'references'];
const parseCombos = (text) => {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const field = comboFieldFromLine(line);
    if (!field) return;
    if (field === 'combo' || (cur && cur[field] !== undefined)) { if (cur) out.push(cur); cur = {}; }
    if (!cur) return;
    cur[field] = collectComboValue(lines, i);
    if (field === 'confidence') {
      const num = cur[field].match(/(\d{1,3})\s*%/);
      cur.confidence_pct = num ? parseInt(num[1], 10) : null;
    }
  });
  if (cur) out.push(cur);
  const cleaned = out.filter((c) => String(c.combo || '').trim());
  if (cleaned.length) {
    const last = cleaned[cleaned.length - 1];
    if (!COMBO_TRAILING_FIELDS.some((f) => last[f] !== undefined)) cleaned.pop();
  }
  return cleaned;
};
// Pre-fix combo parser: requires EXACT underscored labels and never drops a
// truncated final card. Underscore-less labels (EVIDENCETIER, SUPPORTINGEVIDENCE)
// are unrecognized, so RATIONALE swallows them into one raw ALLCAPS blob.
const COMBO_KEYS_LEGACY = [
  'COMBO:', 'RATIONALE:', 'EVIDENCE_TIER:', 'SUPPORTING_EVIDENCE:', 'INTERACTION_RISK:',
  'PATIENT_SPECIFIC_RISKS:', 'CONFIDENCE:', 'HOW_TO_DISCUSS_WITH_DOCTOR:', 'REFERENCES:'
];
const parseCombosLegacy = (text) => {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const key = COMBO_KEYS_LEGACY.find((k) => t.startsWith(k));
    if (!key) return;
    if (key === 'COMBO:') { if (cur) out.push(cur); cur = {}; }
    if (!cur) return;
    const field = key.replace(':', '').toLowerCase();
    cur[field] = collectBlockLegacy(text, i, COMBO_KEYS_LEGACY);
  });
  if (cur) out.push(cur);
  return out;
};
const COMBO_FIELDS = [
  'combo', 'rationale', 'evidence_tier', 'supporting_evidence', 'interaction_risk',
  'patient_specific_risks', 'confidence', 'how_to_discuss_with_doctor', 'references'
];

const leaksFor = (cards, fields) =>
  cards.flatMap((c, i) => auditCardFields(c, fields).map((l) => ({ card: i, ...l })));

// ===========================================================================
// 0. The leak detector itself — true positives AND no false positives.
// ===========================================================================
head('0 — leak detector unit behavior');
{
  const boundary = detectStructuralLeak('[PMID 1](u) --- ### 💊 CARD 2 — Minoxidil WHAT IT DOES: a vasodilator');
  const blob = detectStructuralLeak('Pairs two agents. EVIDENCETIER: SMALL_RCT SUPPORTINGEVIDENCE: a trial. HOWTODISCUSSWITHDOCTOR: ask.');
  const cleanProse = detectStructuralLeak('Slows FVC decline by about half; photosensitivity and GI upset are common.');
  const acronymProse = detectStructuralLeak('Monitor FVC: an acronym mention should not flag. DLCO and HRCT are tracked.');
  const tierValue = detectStructuralLeak('SMALL_RCT');
  if (boundary.includes('CARD boundary') && boundary.includes('WHAT IT DOES:')) {
    pass(`detects card-boundary + consumed intro leak (${boundary.join(', ')})`);
  } else {
    fail(`card-boundary/intro leak not detected (${JSON.stringify(boundary)})`);
  }
  if (blob.some((t) => /EVIDENCETIER/.test(t)) && blob.some((t) => /SUPPORTINGEVIDENCE/.test(t)) && blob.some((t) => /HOWTODISCUSSWITHDOCTOR/.test(t))) {
    pass(`detects underscore-less label blob (${blob.join(', ')})`);
  } else {
    fail(`underscore-less label blob not detected (${JSON.stringify(blob)})`);
  }
  if (!cleanProse.length && !acronymProse.length && !tierValue.length) {
    pass('no false positive on clean prose, an acronym-with-colon, or a tier VALUE');
  } else {
    fail(`false positive (prose=${JSON.stringify(cleanProse)} acronym=${JSON.stringify(acronymProse)} tier=${JSON.stringify(tierValue)})`);
  }
}

// ===========================================================================
// 1. Approved treatments (### 💊 CARD N — delimiters) — AGA defect 1.
// ===========================================================================
head('1 — approved-treatments emoji-delimiter fixture (defect 1)');
{
  const raw = fx('aga-approved-treatments.txt');
  const before = parseTreatmentsLegacy(raw);
  const after = parseTreatments(raw);
  const beforeLeaks = leaksFor(before, TREATMENT_FIELDS);
  const afterLeaks = leaksFor(after, TREATMENT_FIELDS);
  if (beforeLeaks.length) {
    pass(`BEFORE: pre-fix parser leaks ${beforeLeaks.length} structural token(s) — ${beforeLeaks.map((l) => `${l.field}{${l.tokens.join(',')}}`).join(' | ')}`);
  } else {
    fail('BEFORE: expected the pre-fix parser to leak the CARD 2 header into card 1 SOURCES, but found none');
  }
  const both = after.length === 2;
  const structured = both && after.every((t) => t.treatment && t.efficacy_pct != null);
  const fin = after.find((t) => /finasteride/i.test(t.treatment || ''));
  const cleanRefs = fin && /9777765/.test(fin.references) && !/CARD|WHAT IT DOES/i.test(fin.references);
  if (!afterLeaks.length && structured && cleanRefs) {
    pass(`AFTER: 2 structured cards, zero leakage, finasteride SOURCES clean (efficacy ${after[0].efficacy_pct}/${after[1].efficacy_pct})`);
  } else {
    fail(`AFTER: regression (leaks=${afterLeaks.length} structured=${structured} cleanRefs=${cleanRefs} n=${after.length})`);
  }
}

// ===========================================================================
// 1b. Approved treatments (### Drug Card N — delimiters) — defect 1 FORMAT
//     DRIFT: the live MPB report drifted from "### 💊 CARD N —" to
//     "### Drug Card N — <name> — Off-Label", which the un-widened boundary
//     regex did not recognize, so the bleed returned (leak detector caught it).
// ===========================================================================
head('1b — approved-treatments "Drug Card N —" delimiter drift (defect 1)');
{
  const raw = fx('aga-approved-treatments-drugcard.txt');
  const before = parseTreatmentsLegacy(raw);
  const after = parseTreatments(raw);
  const beforeLeaks = leaksFor(before, TREATMENT_FIELDS);
  const afterLeaks = leaksFor(after, TREATMENT_FIELDS);
  if (beforeLeaks.length) {
    pass(`BEFORE: pre-fix parser leaks ${beforeLeaks.length} token(s) on "Drug Card" headers — ${beforeLeaks.map((l) => `${l.field}{${l.tokens.join(',')}}`).join(' | ')}`);
  } else {
    fail('BEFORE: expected the pre-fix parser to leak the "Drug Card 2" header into card 1 SOURCES, but found none');
  }
  const structured = after.length === 2 && after.every((t) => t.treatment && t.efficacy_pct != null);
  const fin = after.find((t) => /finasteride/i.test(t.treatment || ''));
  const cleanRefs = fin && /9777765/.test(fin.references) && !/CARD|WHAT IT DOES/i.test(fin.references);
  if (!afterLeaks.length && structured && cleanRefs) {
    pass(`AFTER: widened boundary parses "Drug Card" variant → 2 structured cards, zero leakage (efficacy ${after[0].efficacy_pct}/${after[1].efficacy_pct})`);
  } else {
    fail(`AFTER: regression (leaks=${afterLeaks.length} structured=${structured} cleanRefs=${cleanRefs} n=${after.length})`);
  }
}

// ===========================================================================
// 2. Combination ideas (underscore-less labels + truncated tail) — defects 2+3.
// ===========================================================================
head('2 — combination-ideas underscore-less + truncated fixture (defects 2+3)');
{
  const raw = fx('aga-combination-ideas.txt');
  const before = parseCombosLegacy(raw);
  const after = parseCombos(raw);
  const beforeLeaks = leaksFor(before, COMBO_FIELDS);
  const afterLeaks = leaksFor(after, COMBO_FIELDS);
  if (beforeLeaks.some((l) => l.field === 'rationale')) {
    pass(`BEFORE: pre-fix combo RATIONALE renders a raw blob — leaks ${beforeLeaks.map((l) => `${l.field}{${l.tokens.join(',')}}`).join(' | ')}`);
  } else {
    fail(`BEFORE: expected the pre-fix combo parser to leak a RATIONALE blob, found ${JSON.stringify(beforeLeaks)}`);
  }
  const droppedTruncated = after.length === 1; // 2nd combo truncated → dropped
  const structured = droppedTruncated &&
    after[0].evidence_tier && after[0].confidence_pct != null &&
    after[0].how_to_discuss_with_doctor && after[0].supporting_evidence;
  if (!afterLeaks.length && structured) {
    pass(`AFTER: 1 structured combo (truncated final dropped), zero leakage, fields split cleanly (tier="${after[0].evidence_tier}", confidence=${after[0].confidence_pct})`);
  } else {
    fail(`AFTER: regression (leaks=${afterLeaks.length} structured=${structured} n=${after.length})`);
  }
}

// ===========================================================================
// 3. Repurposing candidates (clean underscored labels).
// ===========================================================================
head('3 — repurposing-candidates fixture');
{
  const raw = fx('aga-repurpose-candidates.txt');
  const after = parseCandidates(raw);
  const afterLeaks = leaksFor(after, CANDIDATE_FIELDS);
  const structured = after.length === 2 &&
    after.every((c) => c.candidate && c.what_it_does && c.confidence_pct != null);
  if (!afterLeaks.length && structured) {
    pass(`AFTER: 2 structured candidates, zero leakage (${after.map((c) => c.candidate.split(/[—(]/)[0].trim()).join(', ')})`);
  } else {
    fail(`AFTER: regression (leaks=${afterLeaks.length} structured=${structured} n=${after.length})`);
  }
}

// ===========================================================================
// 4. Curated IPF approved treatments (clean PROVIDER/TREATMENT, no emoji) —
//    must NOT regress.
// ===========================================================================
head('4 — curated IPF approved-treatments fixture (no regression)');
{
  const raw = fx('ipf-approved-treatments.txt');
  const after = parseTreatments(raw);
  const afterLeaks = leaksFor(after, TREATMENT_FIELDS);
  const structured = after.length === 2 &&
    after.every((t) => /pirfenidone|nintedanib/i.test(t.treatment) && t.efficacy_pct != null) &&
    after.every((t) => /\d/.test(t.references));
  if (!afterLeaks.length && structured) {
    pass(`AFTER: curated IPF parses to 2 clean cards, zero leakage (efficacy ${after.map((t) => t.efficacy_pct).join('/')})`);
  } else {
    fail(`AFTER: curated IPF regression (leaks=${afterLeaks.length} structured=${structured} n=${after.length})`);
  }
}

// ===========================================================================
// 4b. PROVIDER-only card with no TREATMENT: name (Overactive Bladder defect —
//     the "Medtronic InterStim" card rendered as "(unnamed treatment)" with
//     empty meters). The parser must recover a name from the provider line and
//     drop a card that has neither a name nor any content.
// ===========================================================================
head('4b — PROVIDER-only card recovers a name / drops if empty (unnamed-treatment defect)');
{
  const raw = [
    'PROVIDER: Allergan / AbbVie | Administered by a urologist | DailyMed label',
    'TREATMENT: OnabotulinumtoxinA (Botox) — 100 units into the bladder wall',
    'FDA_STATUS: FDA-approved for OAB',
    'EFFICACY: 65% — reduces urgency incontinence episodes',
    'SAFETY: 65% — urinary retention is the main risk',
    'RISKS: Urinary retention requiring temporary catheterization.',
    'REFERENCES: [AUA/SUFU Guideline](https://doi.org/10.1016/j.juro.2015.01.087)',
    '',
    'PROVIDER: Medtronic InterStim | 1-800-633-8766 | Implanted by a urologist or urogynecologist',
    '',
    'PROVIDER: 1-800-000-0000 | Ask your doctor'
  ].join('\n');
  const after = parseTreatments(raw);
  const noUnnamed = after.every((t) => t.treatment && !/^\(unnamed/i.test(t.treatment));
  const interstim = after.find((t) => /interstim/i.test(t.treatment || ''));
  const emptyDropped = !after.some((t) => !t.treatment && t.efficacy_pct == null && t.safety_pct == null && !t.risks);
  if (after.length === 2 && noUnnamed && interstim && interstim.treatment === 'Medtronic InterStim' && emptyDropped) {
    pass(`AFTER: nameless device card recovered ("${interstim.treatment}"), empty PROVIDER-only card dropped, zero "(unnamed treatment)"`);
  } else {
    fail(`AFTER: unnamed-treatment regression (n=${after.length} noUnnamed=${noUnnamed} interstim=${JSON.stringify(interstim?.treatment)} emptyDropped=${emptyDropped})`);
  }
}

// ===========================================================================
// 5. Corpus completeness — every fixture is exercised.
// ===========================================================================
head('5 — corpus completeness');
{
  const files = readdirSync(FIX_DIR).filter((f) => f.endsWith('.txt'));
  if (files.length >= 4) pass(`${files.length} fixtures present: ${files.join(', ')}`);
  else fail(`expected ≥4 fixtures, found ${files.length}`);
}

// ===========================================================================
// 6. Inline-markdown card-body rendering (Chronic Constipation defect):
//    short card fields (meter note, risks, rationale, etc.) must render
//    **bold** as bold and [label](url) as a real link — NEVER as raw
//    characters. renderInlineMarkdownHtml is the source-of-truth port of the
//    index.html <InlineMD> component; this proves the conversion happens and
//    no literal markdown token survives into the rendered body.
// ===========================================================================
head('6 — inline-markdown card-body rendering (literal **bold**/[label](url) leak)');
{
  // The exact strings the production Chronic Constipation report leaked.
  const meterNote = 'Trials reported **57%** of patients had a response.';
  const risks = 'Cardiac risk noted [(#6 — American Journal of Gastroenterology 2005)](https://doi.org/10.1111/j.1572-0241.2005.41832.x).';
  const noteHtml = renderInlineMarkdownHtml(meterNote);
  const risksHtml = renderInlineMarkdownHtml(risks);

  const boldConverted = /<strong>57%<\/strong>/.test(noteHtml) && !/\*\*/.test(noteHtml);
  const linkConverted = /<a href="https:\/\/doi\.org\/[^"]+" target="_blank" rel="noopener noreferrer">/.test(risksHtml)
    && !/\]\(http/.test(risksHtml) && !/\*\*/.test(risksHtml);
  // Generic: no rendered inline body may still contain literal **bold** or a
  // raw [label](url) markdown link.
  const noLiteral = (html) => !/\*\*[^*]+\*\*/.test(html) && !/\[[^\]]+\]\(https?:\/\//.test(html);

  if (boldConverted && linkConverted && noLiteral(noteHtml) && noLiteral(risksHtml)) {
    pass('renderInlineMarkdownHtml converts **bold**→<strong> and [label](url)→<a target=_blank>; no literal markdown survives');
  } else {
    fail(`inline-markdown rendering regression (bold=${boldConverted} link=${linkConverted} note=${JSON.stringify(noteHtml)} risks=${JSON.stringify(risksHtml)})`);
  }

  // Google-search fallback anchor text is relabelled (never the bare words).
  const googleLabel = cleanAnchorLabel('Google search', 'https://www.google.com/search?q=Augusta+University+Digestive+Health+Center');
  const entityKept = cleanAnchorLabel('Augusta University', 'https://www.google.com/search?q=Augusta');
  const realLink = renderInlineMarkdownHtml('See [Google search](https://www.google.com/search?q=x).');
  if (googleLabel === 'Search ↗' && entityKept === 'Augusta University' && /Search ↗/.test(realLink) && !/Google search/.test(realLink)) {
    pass(`Google-search anchor relabelled to "Search ↗" (bare label), entity-name labels preserved`);
  } else {
    fail(`Google-search relabel regression (label=${JSON.stringify(googleLabel)} entity=${JSON.stringify(entityKept)} link=${JSON.stringify(realLink)})`);
  }

  // The CONFIRMED Parkinson Disease leak: the approved-treatment PROVIDER line
  // shipped a raw markdown link rendered literally because {t.provider} was a
  // bare text node. Mirror the real Crexont case and prove that routing it
  // through InlineMD (renderInlineMarkdownHtml port) yields a real
  // target=_blank link with NO surviving [label](url) literal and no **.
  const providerLeak = 'Multiple manufacturers · Inbrija (Acorda) · [Crexont ER (Impax)](https://clinicaltrials.gov/study/NCT06765668)';
  const providerHtml = renderInlineMarkdownHtml(providerLeak);
  const providerLinked = /<a href="https:\/\/clinicaltrials\.gov\/study\/NCT06765668" target="_blank" rel="noopener noreferrer">/.test(providerHtml);
  const providerPlainKept = /Multiple manufacturers/.test(providerHtml) && /Inbrija \(Acorda\)/.test(providerHtml);
  if (providerLinked && providerPlainKept && noLiteral(providerHtml) && !/\]\(http/.test(providerHtml)) {
    pass('TreatmentCard provider markdown link (Crexont case) renders as <a target=_blank>; no literal [label](url) or ** survives');
  } else {
    fail(`provider markdown-link rendering regression (linked=${providerLinked} plainKept=${providerPlainKept} html=${JSON.stringify(providerHtml)})`);
  }
}

// ===========================================================================
// 7. Source-level guards on index.html — the runtime <InlineMD> component and
//    the de-scaffolded link sanitizer. These pin the static-page behavior the
//    test cannot execute directly, so the rendering fixes cannot silently
//    regress.
// ===========================================================================
head('7 — index.html rendering guards (InlineMD wired, "(link removed" gone)');
{
  const indexSrc = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  // 7a. The internal scaffolding phrase must never be emitted to users again.
  if (!/\(link removed/.test(indexSrc)) {
    pass('index.html no longer emits the internal phrase "(link removed …)" to users');
  } else {
    fail('index.html still contains the internal scaffolding phrase "(link removed …)"');
  }

  // 7b. The InlineMD component exists and is wired into the short prose fields
  //     that previously rendered as bare {field} text nodes.
  const hasComponent = /const InlineMD = \(\{ text \}\) =>/.test(indexSrc);
  const wiredFields = [
    /<InlineMD text=\{note\} \/>/,                          // MeterBar note
    /<InlineMD text=\{t\.risks\} \/>/,                       // TreatmentCard risks
    /<InlineMD text=\{c\.rationale\} \/>/,                   // ComboCard rationale
    /<InlineMD text=\{c\.what_it_does\} \/>/,                // CandidateCard what it does
    /<InlineMD text=\{c\.patient_specific_risks\} \/>/       // patient-specific risks
  ];
  const wiredCount = wiredFields.filter((re) => re.test(indexSrc)).length;
  if (hasComponent && wiredCount === wiredFields.length) {
    pass(`InlineMD component present and wired into ${wiredCount}/${wiredFields.length} key prose fields`);
  } else {
    fail(`InlineMD wiring regression (component=${hasComponent} wired=${wiredCount}/${wiredFields.length})`);
  }

  // 7c. The Google-search relabel helper is present (Section 2 "Google search"
  //     center link defect).
  if (/isGoogleSearchUrl/.test(indexSrc) && /Search ↗/.test(indexSrc)) {
    pass('index.html relabels Google-search anchors (isGoogleSearchUrl + "Search ↗")');
  } else {
    fail('index.html Google-search anchor relabel missing');
  }

  // 7d. sanitizeMarkdownLinks must KEEP Google-search fallback links. Without
  //     this, the de-scaffolded sanitizer (7a) demotes [Google search](google…)
  //     to the bare words "Google search" BEFORE the relabel (7c) can run — the
  //     exact collision that left the bug live after the first fix. Pin that the
  //     allow-check ORs in isGoogleSearchUrl.
  if (/urlIsAllowed\(url, allowedUrls\)\s*\|\|\s*isGoogleSearchUrl\(url\)/.test(indexSrc)) {
    pass('sanitizeMarkdownLinks keeps Google-search links so the relabel can run (no strip-before-relabel)');
  } else {
    fail('sanitizeMarkdownLinks strips Google-search links before relabel — bare "Google search" will leak');
  }

  // 7e. parseTreatments must recover/drop nameless cards so a PROVIDER-only
  //     entry never renders as "(unnamed treatment)" (Overactive Bladder defect).
  if (/deriveTreatmentName/.test(indexSrc)) {
    pass('parseTreatments recovers/drops nameless cards (deriveTreatmentName present)');
  } else {
    fail('parseTreatments has no nameless-card recovery — "(unnamed treatment)" can render');
  }

  // 7f. Comprehensive sweep guard — the FULL class of "literal markdown leaks in
  //     card fields". Every model-supplied prose field that was previously a
  //     bare {field} text node must now be routed through <InlineMD>. The list
  //     below matches EXACTLY what was wired (Parkinson Disease Crexont leak +
  //     siblings). If any regresses to a bare render, this fails loudly.
  const sweepWired = [
    /<InlineMD text=\{t\.provider\} \/>/,                                                  // TreatmentCard provider (CONFIRMED leak)
    /<InlineMD text=\{t\.fda_status\} \/>/,                                                // TreatmentCard FDA status
    /<InlineMD text=\{String\(t\.provider\)\.replace\(\/\^Mechanism:\\s\*\/i, ''\)\} \/>/, // "Also FDA-approved" overflow list provider
    /<InlineMD text=\{c\.class\} \/>/,                                                     // CandidateCard drug class
    /<InlineMD text=\{c\.approved_for\} \/>/,                                              // CandidateCard "usually used for"
    /<InlineMD text=\{String\(c\.mechanism_target\)\.length/,                              // CandidateCard "might work by" / mechanism
    /<InlineMD text=\{v\} \/>/                                                             // ComparisonTable default prose cell (provider/risks/class/etc.)
  ];
  const sweepCount = sweepWired.filter((re) => re.test(indexSrc)).length;
  if (sweepCount === sweepWired.length) {
    pass(`comprehensive markdown-leak sweep: all ${sweepCount}/${sweepWired.length} audited card fields routed through InlineMD`);
  } else {
    const missing = sweepWired.map((re, i) => re.test(indexSrc) ? null : i).filter((x) => x != null);
    fail(`markdown-leak sweep regression — ${sweepWired.length - sweepCount} field(s) not wired via InlineMD (indices ${missing.join(', ')})`);
  }

  // 7g. The CONFIRMED defect must not return: no bare {t.provider} text node.
  //     The Parkinson report leaked because the provider line was rendered as
  //     >{t.provider}< instead of <InlineMD text={t.provider} />.
  if (!/>\{t\.provider\}</.test(indexSrc) && !/>\s*\{t\.provider\}\s*</.test(indexSrc)) {
    pass('no bare >{t.provider}< text node remains (Crexont markdown-link leak cannot recur)');
  } else {
    fail('bare {t.provider} text node still present — markdown in provider would render literally');
  }
}

// ---------------------------------------------------------------------------
// 8 — Excluded-agent filter must drop ONLY the excluded drug, never a
//     legitimate candidate that merely MENTIONS one in its prose. This is the
//     IPF "only 4 drugs" defect: filterExcludedRepurposeCandidates scanned the
//     whole CANDIDATE block, so any candidate whose rationale referenced
//     prednisone / metformin / N-acetylcysteine was silently deleted, collapsing
//     a 12-candidate list to ~4.
// ---------------------------------------------------------------------------
head('8 — excluded-agent filter scopes to the candidate name, not its prose');
{
  const countCand = (t) => (String(t || '').match(/^CANDIDATE:/gm) || []).length;
  const evidence = {
    excludedAgents: [
      { name: 'Metformin as an antifibrotic', aliases: ['metformin', 'Glucophage'] },
      { name: 'Pamrevlumab (FG-3019)' },
      { name: 'N-acetylcysteine monotherapy', aliases: ['n-acetylcysteine'] },
      { name: 'Prednisone monotherapy' }
    ]
  };
  const mkCand = (name, rationale) =>
    `CANDIDATE: ${name}\nCLASS: test class\nWHY_FOR_THIS_CONDITION: hypothesis\n` +
    `REPURPOSE_RATIONALE: ${rationale}\nREFERENCES: [r](https://example.org/1)`;

  // Legit candidates whose rationale references an excluded drug — must SURVIVE.
  const legit = [
    mkCand('Empagliflozin', 'Metabolic pathway, complements the metformin antifibrotic hypothesis.'),
    mkCand('Quercetin', 'Senolytic antioxidant, unlike N-acetylcysteine it acts on senescence.'),
    mkCand('Tofacitinib', 'JAK inhibitor; avoids the steroid harm seen with prednisone.')
  ].join('\n\n');
  const keptText = filterExcludedAgentMentions(legit, evidence);
  if (countCand(keptText) === 3) {
    pass('legitimate candidates mentioning an excluded drug in rationale are KEPT (3/3 survive)');
  } else {
    fail(`excluded-filter over-reach: ${countCand(keptText)}/3 candidates survived (rationale mention wrongly deleted)`);
  }

  // Candidates that ARE the excluded drug — must be DROPPED.
  const offenders = [
    mkCand('Metformin', 'Diabetes drug repurposed for fibrosis.'),
    mkCand('Pamrevlumab', 'Anti-CTGF antibody.')
  ].join('\n\n');
  const droppedText = filterExcludedAgentMentions(offenders, evidence);
  if (countCand(droppedText) === 0) {
    pass('candidates that ARE excluded agents are still DROPPED (guardrail intact, 0/2 survive)');
  } else {
    fail(`excluded-filter guardrail broken: ${countCand(droppedText)}/2 excluded-agent candidates leaked through`);
  }
}

console.log(process.exitCode
  ? '\n\x1b[31mReport-parser regression FAILED\x1b[0m\n'
  : '\n\x1b[32mReport-parser regression passed\x1b[0m\n');
