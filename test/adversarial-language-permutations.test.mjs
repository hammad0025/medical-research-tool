import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  finalizeReportText,
  polishReportForDisplay
} from '../lib/report-polish.js';
import { renderAlertHtml, renderAlertSubject } from '../lib/alerts-email.js';
import { publicError } from '../lib/privacy-redaction.js';
import {
  sanitizePublicHtml,
  sanitizePublicPayload,
  sanitizePublicText
} from '../lib/public-language.js';

const SEED = 0x5eedc0de;
const VARIANTS_PER_TERM = 80;
const ARTIFACT = new URL(
  '../.verify-runs/adversarial-language-permutation-coverage.json',
  import.meta.url
);

// Terms explicitly prohibited by the current reader-language acceptance tests,
// plus concrete internal labels observed in current audit, report, and API code.
// Generic words such as "model", "schema", "pipeline", and "provider" are
// intentionally not banned alone: they occur in legitimate clinical language.
const PROHIBITED_TERMS = [
  { term: 'evidence pack', source: 'user-prohibited' },
  { term: 'K8', source: 'user-prohibited' },
  { term: 'K-8', source: 'user-prohibited' },
  { term: 'diligence packet', source: 'user-prohibited' },
  { term: 'demo rehearsal', source: 'user-prohibited' },
  { term: 'challenge suite', source: 'user-prohibited' },
  { term: 'grounded evidence pack', source: 'patient-safety-audit' },
  { term: 'grounded evidence', source: 'patient-safety-audit' },
  { term: 'dossier-sourced', source: 'report-finalizer' },
  { term: 'disease dossier', source: 'report-finalizer' },
  { term: 'FAERS', source: 'patient-safety-audit' },
  { term: 'prompt pack', source: 'reader-language-audit' },
  { term: 'second AI', source: 'reader-language-audit' },
  { term: 'model fallback chain', source: 'model-audit' },
  { term: 'internal pipeline', source: 'pipeline-audit' },
  { term: 'citation audit', source: 'audit-contract' },
  { term: 'validation status', source: 'audit-contract' },
  { term: 'schema validation', source: 'static-audit' },
  { term: 'saved-demo provenance', source: 'export-contract' },
  { term: 'source SHA', source: 'export-contract' },
  { term: 'server seal', source: 'export-contract' },
  { term: 'report seal', source: 'export-contract' },
  { term: 'profileKey', source: 'schema-label' },
  { term: 'reviewedGitSha', source: 'schema-label' },
  { term: 'coverageMessages', source: 'schema-label' },
  { term: 'REPURPOSE_SECTION', source: 'schema-label' },
  { term: 'EVIDENCE_STRENGTH', source: 'schema-label' },
  { term: 'PATIENT_SPECIFIC_RISKS', source: 'schema-label' },
  { term: 'INTERNAL_ERROR', source: 'public-error-contract' },
  { term: 'upstream stack trace', source: 'public-error-audit' }
];

const NEGATIVE_CONTROLS = [
  {
    kind: 'clinical-phrase',
    text: 'The clinical evidence supports discussing pulmonary rehabilitation with a licensed clinician.'
  },
  {
    kind: 'clinical-phrase',
    text: 'A treatment pipeline can describe medicines being studied; it does not mean they are approved.'
  },
  {
    kind: 'publication-title',
    text: 'Publication title: Validation of a Clinical Prediction Model in Adults With Heart Failure.'
  },
  {
    kind: 'publication-title',
    text: 'Publication title: Data Provenance in Reproducible Genomic Research.'
  },
  {
    kind: 'url',
    text: 'https://clinicaltrials.gov/study/NCT01234567'
  },
  {
    kind: 'url',
    text: 'https://pubmed.ncbi.nlm.nih.gov/12345678/'
  },
  {
    kind: 'trial-status',
    text: 'Trial NCT01234567 is active, not recruiting.'
  },
  {
    kind: 'trial-status',
    text: 'The study status is recruiting.'
  },
  {
    kind: 'doctor-discussion',
    text: 'Prepare a doctor-discussion question about benefits, harms, and alternatives.'
  },
  {
    kind: 'doctor-discussion',
    text: 'Discuss whether this evidence applies to you with your licensed physician.'
  }
];

const CONFUSABLES = new Map([
  ['a', 'а'], // Cyrillic small a
  ['c', 'с'], // Cyrillic small es
  ['e', 'е'], // Cyrillic small ie
  ['i', 'і'], // Cyrillic small Ukrainian i
  ['j', 'ј'], // Cyrillic small je
  ['o', 'о'], // Cyrillic small o
  ['p', 'р'], // Cyrillic small er
  ['s', 'ѕ'], // Cyrillic small dze
  ['x', 'х'], // Cyrillic small ha
  ['y', 'у']  // Cyrillic small u
]);
const REVERSE_CONFUSABLES = new Map([...CONFUSABLES].map(([ascii, unicode]) => [unicode, ascii]));
const ZERO_WIDTH = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff'];
const DASHES = ['-', '‐', '‑', '‒', '–', '—'];
const WRAPPERS = [
  (s) => `**${s}**`,
  (s) => `_${s}_`,
  (s) => `~~${s}~~`,
  (s) => `\`${s}\``,
  (s) => `[${s}](https://example.test/reference)`,
  (s) => `<span>${s}</span>`,
  (s) => `<strong data-label="public">${s}</strong>`,
  (s) => `<!--reader-->${s}<!--/reader-->`
];
const EMBEDDERS = [
  (s) => `The report says ${s} was used for this result.`,
  (s) => `Reader note: ${s}.`,
  (s) => `A patient could see “${s}” in this sentence.`,
  (s) => `Before treatment discussion, the output exposed ${s}; please review.`,
  (s) => `Result one.\n\n${s}\n\nResult two.`
];
const LABELERS = [
  (s) => `{"message":"${s}"}`,
  (s) => `{"schema":{"label":"${s}"}}`,
  (s) => `ERROR_DETAIL: ${s}`,
  (s) => `AUDIT_STATUS=${s}`,
  (s) => `PROVENANCE:\n  value: ${s}`
];

const xorshift32 = (initial) => {
  let state = initial >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
};

const randomCase = (text, random) =>
  [...text].map((char) => random() < 0.5 ? char.toLowerCase() : char.toUpperCase()).join('');

const replaceSafeConfusable = (text, random) => {
  const eligible = [...text].map((char, index) => (
    CONFUSABLES.has(char.toLowerCase()) ? index : -1
  )).filter((index) => index >= 0);
  if (!eligible.length) return text;
  const chosen = eligible[Math.floor(random() * eligible.length)];
  const chars = [...text];
  const lower = chars[chosen].toLowerCase();
  chars[chosen] = CONFUSABLES.get(lower);
  return chars.join('');
};

const mutateSeparators = (text, separator) =>
  text.replace(/[\s_-]+/g, separator);

const generateVariants = ({ term }, termIndex) => {
  const random = xorshift32(SEED ^ Math.imul(termIndex + 1, 0x9e3779b1));
  const variants = new Map();
  const add = (technique, value, shape = 'string') => {
    const text = String(value);
    if (!variants.has(text)) variants.set(text, { technique, text, shape });
  };

  add('baseline', term);
  add('uppercase', term.toUpperCase());
  add('lowercase', term.toLowerCase());
  add('title-case', term.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()));
  add('plural', `${term}s`);
  for (const separator of [' ', '  ', '\t', '\n', '_', '.', '/', ':', ...DASHES]) {
    add(`separator:${JSON.stringify(separator)}`, mutateSeparators(term, separator));
  }
  for (const marker of ZERO_WIDTH) {
    add(`zero-width:${marker.codePointAt(0).toString(16)}`, [...term].join(marker));
  }
  for (const [index, wrap] of WRAPPERS.entries()) add(`wrapper:${index}`, wrap(term));
  for (const [index, embed] of EMBEDDERS.entries()) add(`sentence:${index}`, embed(term));
  for (const [index, label] of LABELERS.entries()) add(`label:${index}`, label(term));
  const split = Math.max(1, Math.floor(term.length / 2));
  add('concatenated-fields', `${term.slice(0, split)}\u241f${term.slice(split)}`, 'fields');

  let attempt = 0;
  while (variants.size < VARIANTS_PER_TERM && attempt < 1000) {
    attempt += 1;
    let value = randomCase(term, random);
    const operations = 1 + Math.floor(random() * 4);
    for (let index = 0; index < operations; index += 1) {
      const operation = Math.floor(random() * 7);
      if (operation === 0) value = mutateSeparators(value, DASHES[Math.floor(random() * DASHES.length)]);
      if (operation === 1) value = mutateSeparators(value, random() < 0.5 ? '\n' : '\t');
      if (operation === 2) value = [...value].join(ZERO_WIDTH[Math.floor(random() * ZERO_WIDTH.length)]);
      if (operation === 3) value = replaceSafeConfusable(value, random);
      if (operation === 4) value = WRAPPERS[Math.floor(random() * WRAPPERS.length)](value);
      if (operation === 5) value = EMBEDDERS[Math.floor(random() * EMBEDDERS.length)](value);
      if (operation === 6) value = LABELERS[Math.floor(random() * LABELERS.length)](value);
    }
    add(`seeded-random:${attempt}`, value);
  }
  assert.equal(variants.size, VARIANTS_PER_TERM, `insufficient unique variants for ${term}`);
  return [...variants.values()];
};

const canonicalize = (value) => {
  let text = String(value ?? '').normalize('NFKC').toLowerCase();
  text = [...text].map((char) => REVERSE_CONFUSABLES.get(char) || char).join('');
  return text
    .replace(/&(?:nbsp|ensp|emsp|thinsp|zwnj|zwj);/g, '')
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
};

const termLeaked = (output, term) => {
  const haystack = canonicalize(output);
  const needle = canonicalize(term);
  return haystack.includes(needle) || haystack.includes(`${needle}s`);
};

const flattenPublicText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenPublicText).join('\n');
  if (typeof value === 'object') return Object.values(value).map(flattenPublicText).join('\n');
  return String(value);
};

const loadFrontendBoundaries = async () => {
  const source = await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing frontend boundary ${start}`);
    return source.slice(from, to);
  };

  const clientPolisherSource = between(
    'const polishReportForDisplay =',
    '// Keep a "## 3. Approved Treatments"'
  );
  const structuralScannerSource = between(
    'const STRUCTURAL_FIELD_LABELS =',
    'const TRIAL_KEYS ='
  );
  const exportCssSource = between(
    'const EXPORT_PRINT_CSS =',
    '// Build the standalone HTML document'
  );
  const buildExportSource = between(
    'const buildExportDocument =',
    '// Print a built HTML document'
  );
  const escapeSource = between(
    'const escapeHtmlForExport =',
    'const FullReportExportButton ='
  ).split('const FullReportExportButton =')[0];

  const clientPolisher = Function(
    `"use strict"; ${clientPolisherSource}; return polishReportForDisplay;`
  )();
  const scanner = Function(
    `"use strict"; ${structuralScannerSource}; return { detectStructuralLeak, auditAndScrubCard };`
  )();
  const buildExportDocument = Function(
    'MEDICAL_DISCLAIMER',
    'publicTextOrFallback',
    `"use strict"; ${exportCssSource}; ${buildExportSource}; ${escapeSource}; return buildExportDocument;`
  )(
    'Disclaimer: This is educational medical research support, not medical advice.',
    (value, fallback = 'This information is temporarily unavailable.') => {
      try { return sanitizePublicText(value); } catch { return fallback; }
    }
  );

  return { clientPolisher, ...scanner, buildExportDocument };
};

const emailInput = (text) => ({
  sub: { condition: text, patientContext: null },
  condition: text,
  newItems: [{
    title: 'Example publication title',
    journal: 'Example Journal',
    year: 2026,
    url: 'https://example.test/study',
    text
  }],
  trials: [],
  qualityBreakdown: null
});

test('fixed-seed adversarial language permutations fail on every surviving public leak', async () => {
  const frontend = await loadFrontendBoundaries();
  const corpus = PROHIBITED_TERMS.flatMap((definition, termIndex) =>
    generateVariants(definition, termIndex).map((variant) => ({
      ...definition,
      ...variant,
      id: `${String(termIndex + 1).padStart(2, '0')}-${variant.technique}`
    }))
  );
  assert.ok(corpus.length >= 2_000, `expected thousands of variants, got ${corpus.length}`);

  const boundaries = [
    {
      name: 'report-finalizer',
      run: ({ text }) => finalizeReportText(text, {
        evidence: {},
        trials: {},
        patient: { condition: 'Example condition' }
      })
    },
    {
      name: 'chat-finalizer',
      run: ({ text }) => finalizeReportText(`Answer to the patient:\n${text}`, {
        evidence: {},
        trials: {},
        patient: { condition: 'Example condition' }
      })
    },
    { name: 'server-display-polisher', run: ({ text }) => polishReportForDisplay(text, { keepHedges: true }) },
    { name: 'browser-display-polisher', run: ({ text }) => frontend.clientPolisher(text, { keepHedges: true }) },
    {
      name: 'api-public-error',
      run: ({ text, shape }) => shape === 'fields'
        ? sanitizePublicPayload(publicError(text.split('\u241f')[0], text.split('\u241f')[1]))
        : sanitizePublicPayload(publicError(text, 'PUBLIC_REQUEST_FAILED'))
    },
    {
      name: 'alert-email',
      run: ({ text }) => `${renderAlertSubject(emailInput(text))}\n${renderAlertHtml(emailInput(text))}`
    },
    {
      name: 'export-document',
      run: ({ text }) => {
        const polished = frontend.clientPolisher(text, { keepHedges: true });
        return frontend.buildExportDocument({
          bodyHtml: `<p>${polished}</p>`,
          title: polished,
          verification: ''
        });
      }
    },
    {
      name: 'ui-public-string-scanner',
      run: ({ text }) => sanitizePublicText(text)
    },
    {
      name: 'ui-public-html-scanner',
      run: ({ text }) => sanitizePublicHtml(`<p>${text}</p>`)
    },
    {
      name: 'ui-structural-card-scanner',
      run: ({ text, shape, source }) => {
        if (shape !== 'fields' && !/^(?:schema-label|audit-contract)$/.test(source)) return '';
        const value = shape === 'fields' ? text.split('\u241f').join('') : text;
        const scrubbed = frontend.auditAndScrubCard(
          { rationale: value },
          ['rationale'],
          { kind: 'candidate', label: 'Adversarial fixture', condition: 'Example condition' }
        );
        return scrubbed.card.rationale || '';
      }
    }
  ];

  const bypasses = [];
  const byBoundary = Object.fromEntries(boundaries.map(({ name }) => [
    name,
    { exercised: 0, blocked: 0, leaked: 0 }
  ]));
  const byTechnique = {};
  const bySource = {};

  for (const variant of corpus) {
    byTechnique[variant.technique] ||= { variants: 0, boundaryExecutions: 0, leaks: 0 };
    byTechnique[variant.technique].variants += 1;
    bySource[variant.source] ||= { terms: new Set(), variants: 0, leaks: 0 };
    bySource[variant.source].terms.add(variant.term);
    bySource[variant.source].variants += 1;

    for (const boundary of boundaries) {
      let rawOutput = '';
      try {
        rawOutput = boundary.run(variant);
      } catch {
        // A fail-closed public-language rejection is a blocked leak.
      }
      const output = flattenPublicText(rawOutput);
      const leaked = termLeaked(output, variant.term);
      byBoundary[boundary.name].exercised += 1;
      byTechnique[variant.technique].boundaryExecutions += 1;
      if (leaked) {
        byBoundary[boundary.name].leaked += 1;
        byTechnique[variant.technique].leaks += 1;
        bySource[variant.source].leaks += 1;
        bypasses.push({
          boundary: boundary.name,
          term: variant.term,
          source: variant.source,
          technique: variant.technique,
          input: variant.text,
          outputLength: output.length,
          outputExcerpt: (() => {
            const index = output.indexOf(variant.text);
            if (index < 0) return output.slice(0, 600);
            return output.slice(Math.max(0, index - 120), index + variant.text.length + 120);
          })()
        });
      } else {
        byBoundary[boundary.name].blocked += 1;
      }
    }
  }

  const negativeControlResults = [];
  for (const control of NEGATIVE_CONTROLS) {
    const server = polishReportForDisplay(control.text, { keepHedges: true });
    const browser = frontend.clientPolisher(control.text, { keepHedges: true });
    const publicBoundary = sanitizePublicText(control.text, {
      sourceTitle: control.kind === 'publication-title'
    });
    negativeControlResults.push({
      ...control,
      server,
      browser,
      publicBoundary,
      preserved: canonicalize(server).includes(canonicalize(control.text)) &&
        canonicalize(browser).includes(canonicalize(control.text)) &&
        canonicalize(publicBoundary).includes(canonicalize(control.text))
    });
  }

  const summary = {
    schemaVersion: '1.0',
    suite: 'deterministic-adversarial-language-permutations',
    seed: `0x${SEED.toString(16)}`,
    generatedAt: 'deterministic-fixed-seed',
    configuration: {
      terms: PROHIBITED_TERMS.length,
      variantsPerTerm: VARIANTS_PER_TERM,
      variants: corpus.length,
      boundaries: boundaries.map(({ name }) => name),
      boundaryExecutions: corpus.length * boundaries.length,
      negativeControls: NEGATIVE_CONTROLS.length
    },
    coverage: {
      categories: [
        'casing', 'plurals', 'punctuation', 'hyphens', 'en-dashes', 'em-dashes',
        'whitespace', 'newlines', 'zero-width', 'unicode-confusables',
        'markdown', 'html', 'json-schema-labels', 'sentence-embedding',
        'concatenated-field-values'
      ],
      byBoundary,
      byTechnique,
      bySource: Object.fromEntries(Object.entries(bySource).map(([key, value]) => [
        key,
        { ...value, terms: [...value.terms].sort() }
      ]))
    },
    negativeControls: negativeControlResults,
    result: {
      leaks: bypasses.length,
      destructiveFiltering: negativeControlResults.filter((item) => !item.preserved).length,
      pass: bypasses.length === 0 && negativeControlResults.every((item) => item.preserved)
    },
    exactBypasses: bypasses
  };

  await mkdir(new URL('../.verify-runs/', import.meta.url), { recursive: true });
  await writeFile(ARTIFACT, `${JSON.stringify(summary, null, 2)}\n`);

  assert.deepEqual(
    negativeControlResults.filter((item) => !item.preserved),
    [],
    'legitimate reader language was destructively filtered'
  );
  assert.equal(
    bypasses.length,
    0,
    `${bypasses.length} public language bypasses survived; exact inputs and outputs: ${ARTIFACT.pathname}`
  );
});
