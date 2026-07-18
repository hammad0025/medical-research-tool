import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX_PATH = path.join(ROOT, 'index.html');

const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`index.html parser source missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`index.html parser source missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

export const loadProductionReportParsers = () => {
  const indexSource = readFileSync(INDEX_PATH, 'utf8');
  const dependencySource = [
    sliceBetween(indexSource, '      const drugKeysMatch =', '      const approvedPipelineDrugs ='),
    sliceBetween(indexSource, '      const parseHeadlinePercent =', '      const extractLinksFromText ='),
    sliceBetween(indexSource, '      const SAFETY_BAND_LEVEL =', '      /* ==================== Storage ==================== */')
  ].join('\n');
  const parserSource = sliceBetween(
    indexSource,
    '      const CARD_BOUNDARY_RE =',
    '      // Loud leak-detector invariant'
  );

  const context = vm.createContext({});
  new vm.Script(`
    ${dependencySource}
    ${parserSource}
    globalThis.__reportParsers = {
      parseTreatments,
      parseCandidates,
      parseCombos,
      collectBlock,
      isCardBoundaryLine,
      parseBandRating
    };
  `, { filename: INDEX_PATH }).runInContext(context);

  return {
    ...context.__reportParsers,
    source: parserSource
  };
};
