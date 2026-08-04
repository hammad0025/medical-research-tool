import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { drugKeysMatch } from '../../lib/report-polish.js';
import {
  resolveItemKind,
  resolveRepurposeSection,
  REPURPOSE_SECTION_DISPLAY_CAP,
  extractCitationUrls,
  isGoogleSearchUrl,
  isDailyMedSearchUrl,
  isPipelineProgramme
} from '../../lib/repurpose-quality.js';
import { agentDedupKeys, declaresNotApproved } from '../../lib/card-identity.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SOURCE_PATH = path.join(ROOT, 'src', 'app.jsx');

const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`frontend parser source missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`frontend parser source missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

export const loadProductionReportParsers = () => {
  const indexSource = readFileSync(APP_SOURCE_PATH, 'utf8');
  const dependencySource = [
    sliceBetween(indexSource, 'const parseHeadlinePercent =', 'const extractLinksFromText ='),
    sliceBetween(indexSource, 'const SAFETY_BAND_LEVEL =', '/* ==================== Storage ==================== */')
  ].join('\n');
  const parserSource = sliceBetween(
    indexSource,
    'const CARD_BOUNDARY_RE =',
    '// Loud leak-detector invariant'
  );

  const context = vm.createContext({
    drugKeysMatch,
    resolveRepurposeSection,
    resolveItemKind,
    // partitionCandidates caps each section with this shared constant and
    // checks whether a candidate still carries a usable citation.
    REPURPOSE_SECTION_DISPLAY_CAP,
    extractCitationUrls,
    isGoogleSearchUrl,
    isDailyMedSearchUrl,
    isPipelineProgramme,
    // parseCandidates keys duplicate cards by these, and parseTreatments uses
    // the approval test to keep investigational agents out of the approved lane.
    agentDedupKeys,
    declaresNotApproved
  });
  new vm.Script(`
    ${dependencySource}
    ${parserSource}
    globalThis.__reportParsers = {
      parseTreatments,
      parseCandidates,
      parseCombos,
      resolveRepurposeSection,
      resolveItemKind,
      partitionCandidates,
      collectBlock,
      isCardBoundaryLine,
      parseBandRating
    };
  `, { filename: APP_SOURCE_PATH }).runInContext(context);

  return {
    ...context.__reportParsers,
    source: parserSource
  };
};
