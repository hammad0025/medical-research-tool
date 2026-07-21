import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { drugKeysMatch } from '../../lib/report-polish.js';
import { resolveItemKind, resolveRepurposeSection } from '../../lib/repurpose-quality.js';

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

  const context = vm.createContext({ drugKeysMatch, resolveRepurposeSection, resolveItemKind });
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
