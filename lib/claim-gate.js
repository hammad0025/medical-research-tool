// The citation gate, stated once.
//
// This is a candidate replacement for the claim-checking spread across
// finalizeReportText's 48 passes and 24 deletion sites. It is NOT wired in —
// scripts/compare-claim-gate.mjs runs it beside the existing pipeline over real
// reports so the two can be diffed. Where they agree, the old passes are
// redundant. Where they differ, the difference names the constraint the old
// code was encoding, which is how that knowledge gets recovered instead of
// lost.
//
// The job, in full: a sentence in model prose that asserts a medical fact must
// carry a link to a source that actually supports it. Everything else the old
// pipeline does is either a special case of that, or applies to data that no
// longer passes through here at all — curated centres, safety flags, registry
// records and the idea lanes are rendered from verified data after every pass
// has run.

import { claimSupportedBySource } from './claim-source-proof.js';
import { canonicalizeCitationUrl, isGoogleSearchUrl, isDailyMedSearchUrl } from './citation-gate.js';

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * Sentences, keeping trailing punctuation so a citation stays attached.
 *
 * Markdown links are masked first: a naive split on "." cuts a citation in half
 * at the dots in "pubmed.ncbi.nlm.nih.gov", leaving a claim that appears to
 * have no source. This gate deleted a correctly-cited sentence on its very
 * first test for exactly that reason — and it is almost certainly one of the
 * constraints the old pipeline's own splitter was written to handle.
 */
const sentences = (line) => {
  const links = [];
  const masked = String(line).replace(/\[[^\]]*\]\([^)\s]*\)/g, (match) => {
    links.push(match);
    return `\u0000${links.length - 1}\u0000`;
  });
  const parts = masked.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  return parts.map((part) =>
    part.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]));
};

// A line that structures the page rather than asserting anything: headings,
// table rows, bullets that are only a label, blank lines.
const isStructural = (line) => {
  const t = String(line || '').trim();
  if (!t) return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^\|/.test(t)) return true;
  if (/^[-*]\s*$/.test(t)) return true;
  if (/^[A-Z][A-Za-z ,&/'-]{2,60}:$/.test(t)) return true;
  return false;
};

// Asserting something about the world, as opposed to describing the page or
// addressing the reader.
const NAVIGATION = /^(?:jump to|see section|tap |sort by|select |ask your|discuss|talk to|exports include|for learning)/i;
const HEDGE_ONLY = /^(?:no |none |nothing |not established|no condition-specific)/i;

export const isMedicalClaim = (sentence) => {
  const t = String(sentence || '').trim();
  if (t.length < 25) return false;
  if (NAVIGATION.test(t)) return false;
  if (HEDGE_ONLY.test(t)) return false;
  // A claim says something happened, is true, or has an effect.
  return /\b(?:is|are|was|were|has|have|had|can|may|might|shows?|showed|found|reported|reduces?|reduced|improves?|improved|slows?|slowed|increases?|increased|causes?|caused|associated|linked|approved|indicated|recommended|prevents?|protects?)\b/i
    .test(t);
};

const linksIn = (sentence) => {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(sentence)) !== null) out.push({ label: m[1], url: m[2] });
  return out;
};

const usableCitation = (url) =>
  /^https?:\/\//i.test(url) && !isGoogleSearchUrl(url) && !isDailyMedSearchUrl(url);

/**
 * @param {string} text        model prose
 * @param {object} evidence    the pack the model was given
 * @param {object} options     { condition }
 * @returns {{text, removed: Array, kept: number}}
 */
export const applyClaimGate = (text, evidence, { condition = '' } = {}) => {
  const items = (evidence?.groundedForPrompt || []).filter(Boolean);
  const byUrl = new Map();
  for (const item of items) {
    const url = canonicalizeCitationUrl(item?.url);
    if (url) byUrl.set(url, item);
  }

  const removed = [];
  let kept = 0;

  const out = String(text || '').split('\n').map((line) => {
    if (isStructural(line)) return line;
    const rebuilt = sentences(line).map((sentence) => {
      if (!isMedicalClaim(sentence)) return sentence;
      const links = linksIn(sentence).filter((l) => usableCitation(l.url));
      if (!links.length) {
        removed.push({ reason: 'no-citation', sentence: sentence.trim().slice(0, 120) });
        return '';
      }
      // At least one cited source must actually support the sentence.
      const supported = links.some((link) => {
        const item = byUrl.get(canonicalizeCitationUrl(link.url));
        if (!item) return false;
        return claimSupportedBySource(sentence, item, { condition }).ok;
      });
      if (!supported) {
        removed.push({ reason: 'source-does-not-support', sentence: sentence.trim().slice(0, 120) });
        return '';
      }
      kept += 1;
      return sentence;
    }).join('');
    return rebuilt;
  }).join('\n');

  return { text: out.replace(/\n{3,}/g, '\n\n'), removed, kept };
};
