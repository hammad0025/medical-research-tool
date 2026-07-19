import {
  buildGroundingIndex,
  isClaimGrounded
} from './grounding-gate.js';

export const kbEvidenceRefs = (record) => [
  record?.evidenceRef,
  ...(Array.isArray(record?.evidenceRefs) ? record.evidenceRefs : [])
].filter(Boolean);

const groundingItem = (item) => ({
  title: item?.title || '',
  journal: item?.journal || '',
  year: item?.year || '',
  summary: item?.summary || '',
  keyPassages: (item?.keyPassages || []).map((passage) => passage?.quote || '').filter(Boolean)
});

export const kbItemsGroundingIndex = (items) => buildGroundingIndex({
  evidencePack: items.map(groundingItem)
});

export const kbClaimSegments = (claim) =>
  String(claim || '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((segment) => segment.trim())
    .filter(Boolean);

export const kbFactGroundingStatus = (record, itemsById) => {
  const claim = String(record?.claim || record?.recommendation || '').trim();
  const refs = kbEvidenceRefs(record);
  if (!claim) return { grounded: false, reason: 'EMPTY_CLAIM', refs, unsupported: [] };
  if (!refs.length) return { grounded: false, reason: 'MISSING_REFS', refs, unsupported: [claim] };
  const missingRefs = refs.filter((ref) => !itemsById.has(ref));
  if (missingRefs.length) {
    return { grounded: false, reason: 'UNRESOLVED_REFS', refs, missingRefs, unsupported: [claim] };
  }
  const items = refs.map((ref) => itemsById.get(ref));
  const index = kbItemsGroundingIndex(items);
  const unsupported = kbClaimSegments(claim)
    .filter((segment) => !isClaimGrounded(segment, index));
  return {
    grounded: unsupported.length === 0,
    reason: unsupported.length ? 'UNSUPPORTED_CLAIM' : '',
    refs,
    missingRefs: [],
    unsupported
  };
};

export const filterGroundedKbRecords = (records, itemsById) =>
  (records || []).filter((record) => kbFactGroundingStatus(record, itemsById).grounded);
