// Wrong-disease contamination guard.
//
// Dorothy failure mode: an RP/IPF report citing or discussing sickle cell (or
// another unrelated disease). Prefer deleting the contaminated sentence / pack
// item over leaving a "live but wrong" paper next to the claim.
//
// Used by:
//   - evidence gather (drop wrong-disease pack items before Claude sees them)
//   - finalizeReportText (strip prose + demote cites)
//   - client Research / Word / Refs (belt-and-suspenders)

import { sourceMentionsCondition } from './grounding-gate.js';
import { isUnverifiedDocumentUrl } from './citation-gate.js';

/** Distinctive foreign-disease phrases. `self` matches the patient's own condition. */
export const FOREIGN_DISEASE_MARKERS = [
  {
    id: 'sickle-cell',
    self: /\bsickle\b/i,
    phrases: [
      /\bsickle\s*cell\b/i,
      /\bHbSS\b/,
      /\bvaso-?occlusive (?:pain )?crisis\b/i,
      /\bcrizanlizumab\b/i,
      /\bvoxelotor\b/i,
      /\bCasgevy\b/i,
      /\bexa-?cel\b/i,
      /\bLyfgenia\b/i,
      /\blovo-?cel\b/i,
      /\bOxbryta\b/i,
      /\bAdakveo\b/i
    ]
  },
  { id: 'alzheimer', self: /\balzheimer/i, phrases: [/\balzheimer['']?s?\b/i] },
  { id: 'parkinson', self: /\bparkinson/i, phrases: [/\bparkinson['']?s?\b/i] },
  { id: 'huntington', self: /\bhuntington/i, phrases: [/\bhuntington['']?s?\b/i] },
  { id: 'duchenne', self: /\bduchenne|\bDMD\b/, phrases: [/\bduchenne\b/i] },
  { id: 'retinitis', self: /\bretinitis|\bRP\b|pigmentosa/i, phrases: [/\bretinitis\s+pigmentosa\b/i] },
  { id: 'ipf', self: /\bpulmonary\s+fibrosis|\bIPF\b|\bfibrosing\s+alveolitis\b/i, phrases: [/\bidiopathic\s+pulmonary\s+fibrosis\b/i] },
  { id: 'schizophrenia', self: /\bschizophren/i, phrases: [/\bschizophrenia\b/i] },
  { id: 'bipolar', self: /\bbipolar\b/i, phrases: [/\bbipolar\s+disorder\b/i] },
  { id: 'lada', self: /\bLADA\b|latent\s+autoimmune/i, phrases: [/\blatent\s+autoimmune\s+diabetes\b/i, /\bLADA\b/] },
  { id: 't1d', self: /\btype\s*1\s+diabetes|\bT1D\b/i, phrases: [/\btype\s*1\s+diabetes\b/i] },
  { id: 't2d', self: /\btype\s*2\s+diabetes|\bT2D\b/i, phrases: [/\btype\s*2\s+diabetes\b/i] },
  { id: 'als', self: /\bALS\b|amyotrophic/i, phrases: [/\bamyotrophic\s+lateral\s+sclerosis\b/i] },
  { id: 'lca', self: /\bleber\s+congenital|\bLCA\b/i, phrases: [/\bleber\s+congenital\s+amaurosis\b/i] }
];

/** Active foreign markers for a patient condition (excludes the patient's own disease). */
export const activeForeignMarkers = (patientCondition = '') => {
  const cond = String(patientCondition || '').trim();
  if (!cond) return [];
  return FOREIGN_DISEASE_MARKERS.filter((m) => !m.self.test(cond));
};

/** True when blob clearly names a disease the patient does not have. */
export const blobMentionsForeignDisease = (blob, patientCondition = '') => {
  const active = activeForeignMarkers(patientCondition);
  if (!active.length) return false;
  const text = String(blob || '');
  return active.some((m) => m.phrases.some((re) => re.test(text)));
};

/**
 * Drop sentences that name a different disease than the patient's condition.
 * Also scrubs contaminated headings (## Sickle cell … on an IPF report).
 * Returns { text, stripped }.
 */
export const stripForeignDiseaseContamination = (text, patientCondition = '') => {
  if (!text) return { text, stripped: [] };
  const cond = String(patientCondition || '').trim();
  if (!cond) return { text, stripped: [] };

  const active = activeForeignMarkers(cond);
  if (!active.length) return { text, stripped: [] };

  const stripped = [];
  const lines = String(text).split('\n');
  const out = lines.map((line) => {
    // A contaminated structured row is unsafe as a whole. Keeping table cells
    // bypassed the prose scrub and exposed wrong-disease trials/drugs.
    if (line.includes('|') && line.split('|').length >= 3) {
      const hit = active.find((m) => m.phrases.some((re) => re.test(line)));
      if (hit) {
        stripped.push(`${hit.id}: ${line.trim().slice(0, 120)}`);
        return '';
      }
      return line;
    }
    // CANDIDATE: lines naming a foreign disease as the drug subject — rare; skip rename.

    const hitLine = active.find((m) => m.phrases.some((re) => re.test(line)));
    // Contaminated heading → drop the whole heading line.
    if (hitLine && /^\s{0,3}#{1,6}\s/.test(line)) {
      stripped.push(`${hitLine.id}: ${line.trim().slice(0, 120)}`);
      return '';
    }

    // Split on sentence boundaries; drop any sentence that hits a foreign marker.
    const parts = line.split(/(?<=[.!?])\s+/);
    const kept = [];
    for (const part of parts) {
      const hit = active.find((m) => m.phrases.some((re) => re.test(part)));
      if (hit) {
        stripped.push(`${hit.id}: ${part.trim().slice(0, 120)}`);
        continue;
      }
      kept.push(part);
    }
    if (!kept.length) return '';
    const lead = line.match(/^(\s*[-*•]\s+)/);
    const body = kept.join(' ').trim();
    if (!body) return '';
    if (lead && !/^\s*[-*•]\s/.test(body)) return `${lead[1]}${body}`;
    return (line.match(/^\s*/)?.[0] || '') + body;
  });

  const cleaned = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n');
  return { text: cleaned, stripped };
};

/**
 * Drop evidence-pack items about a different disease before Claude / Refs / Word
 * ever see them. Curated records must carry condition provenance matching the
 * active condition; the curated flag alone is never a trust bypass.
 */
export const filterEvidencePackByCondition = (items, patientCondition = '') => {
  const conditionNames = (Array.isArray(patientCondition) ? patientCondition : [patientCondition])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const cond = conditionNames[0] || '';
  if (!cond || !Array.isArray(items) || !items.length) return items || [];

  const kept = [];
  let dropped = 0;
  for (const a of items) {
    const blob = `${a.title || ''} ${a.abstract || ''} ${a.fullText || ''} ${a.text || ''} ${a.summary || ''} ${a.category || ''}`;
    if (blobMentionsForeignDisease(blob, cond)) {
      dropped += 1;
      continue;
    }
    // Curated records are privileged only when their loader-provided condition
    // provenance positively matches this request. Missing or mismatched metadata
    // fails closed so a poisoned KB cannot bypass the content checks.
    if (a.isCuratedKB) {
      const kbCondition = String(a.kbCondition || '').trim();
      const provenanceMatches = kbCondition
        ? conditionNames.some((name) =>
            sourceMentionsCondition(kbCondition, name) === true
            || sourceMentionsCondition(name, kbCondition) === true
          )
        : false;
      if (provenanceMatches) kept.push(a);
      else dropped += 1;
      continue;
    }
    const mentions = conditionNames.map((name) => sourceMentionsCondition(blob, name));
    const mention = mentions.includes(true)
      ? true
      : mentions.every((value) => value === false) ? false : null;
    if (mention === false) {
      dropped += 1;
      continue;
    }
    // Empty / unknown abstract on a document URL: fail-closed — do not seed pack.
    const url = a.url || a.pubmedUrl || a.pmcUrl || a.doiUrl || a.oaUrl || '';
    if (mention == null && isUnverifiedDocumentUrl(url) && !String(blob).trim()) {
      dropped += 1;
      continue;
    }
    kept.push(a);
  }
  if (dropped) {
    console.warn(
      `[disease-contamination] dropped ${dropped} wrong-disease pack item(s) for condition="${cond}"`
    );
  }
  return kept;
};

/**
 * May this citation URL stay attached for this patient condition?
 * Document URLs: require positive condition mention (true). Registry/label: null OK.
 */
export const conditionCiteAllowed = (rel, url) => {
  if (rel === false) return false;
  if (rel === true) return true;
  // null / unknown
  return !isUnverifiedDocumentUrl(url);
};
