// Lint the FINISHED report — the text a patient actually reads.
//
// Every defect encoded here shipped to a real user at least once, because the
// change that caused it was verified at the layer it touched rather than on the
// rendered page. A card carried a literal "<h4>Background</h4>" tag; the paper
// count reported the size of our own slice as the size of the literature; whole
// sections rendered as "Nothing was found" while the data sat loaded one
// function away; the idea list collapsed to two entries twice.
//
// Anything this module flags is something a reader would notice. Keep the rules
// output-shaped: they take rendered text and ask what the page looks like, not
// how it was produced.

const RULES = [
  {
    id: 'raw-html',
    describe: 'HTML markup reaching the reader',
    test: (line) => /<\/?(?:h[1-6]|div|span|p|br|table|td|tr|b|i|em|strong)\b[^>]*>/i.test(line)
  },
  {
    id: 'abstract-prefix',
    describe: 'raw abstract section prefix left on a card',
    test: (line) => /(?:^|\s)(?:OBJECTIVE|BACKGROUND|METHODS?|RESULTS?|CONCLUSIONS?|PURPOSE|AIM|Editor'?s summary)\s*:/.test(line)
  },
  {
    id: 'internal-identifier',
    describe: 'internal field name or identifier reaching the reader',
    test: (line) => /\b(?:REPURPOSE_SECTION|EVIDENCE_STRENGTH|ITEM_KIND|WHY_FOR_THIS_CONDITION|SUPPORTING_EVIDENCE|sourceSHA|cacheHit|schemaVersion|promptPackBreakdown|generatedBy|modelRequested)\b/.test(line)
  },
  {
    id: 'empty-link',
    describe: 'link with no destination',
    test: (line) => /\]\(\s*\)|\]\(#\)/.test(line)
  },
  {
    id: 'double-arrow',
    describe: 'duplicated citation arrow',
    test: (line) => /↗\s*↗/.test(line)
  },
  {
    id: 'stale-cross-reference',
    describe: 'reference to content that may not exist in an export',
    test: (line) => /\b(?:cards? above|see above|listed above|as shown above)\b/i.test(line)
  },
  {
    id: 'truncated-mid-word',
    describe: 'text cut off mid-word',
    test: (line) => /[a-z]{3,}\s*$/.test(line) && /\b(?:followe|inclu|degenerati|treatmen|patien|associat|conditio)\b\s*$/i.test(line)
  }
];

const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const isRow = (line) => /^\s*\|/.test(String(line || ''));

/**
 * @returns {{defects: Array, sections: object, ok: boolean}}
 */
export const lintReport = (report, { expectedSections = 8 } = {}) => {
  const text = String(report || '');
  const lines = text.split('\n');
  const defects = [];
  const add = (id, describe, line, sample) =>
    defects.push({ id, describe, line, sample: String(sample).trim().slice(0, 110) });

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.test(line)) add(rule.id, rule.describe, index + 1, line);
    }
    // A lone table row renders as literal pipe characters mid-paragraph.
    if (isRow(line) && !TABLE_SEPARATOR.test(line.trim()) &&
      !isRow(lines[index - 1]) && !isRow(lines[index + 1])) {
      add('orphan-table-row', 'table row with no table around it', index + 1, line);
    }
    // Pipes in prose are a table that failed to render.
    if (!isRow(line) && (line.match(/\|/g) || []).length >= 3) {
      add('pipes-in-prose', 'table characters shown as prose', index + 1, line);
    }
    // Rows joined onto one line: the table collapsed and the reader sees a
    // wall of pipe characters. A genuine row has one pipe per column boundary.
    if (isRow(line) && !TABLE_SEPARATOR.test(line.trim()) && /\|\s*\|/.test(line)) {
      add('pipes-in-prose', 'table rows joined into one line', index + 1, line);
    }
  });

  // Section fill: a heading whose only content is the empty-state note.
  const parts = text.split(/(?=^##\s*\d+\.)/m).filter((part) => /^##\s*\d+\./.test(part));
  const empty = [];
  for (const part of parts) {
    const heading = part.split('\n')[0].trim();
    const body = part.split('\n').slice(1)
      .filter((l) => l.trim() && !/^Nothing was found/i.test(l.trim()));
    if (!body.length) empty.push(heading.replace(/^##\s*/, ''));
  }
  // An empty report must FAIL, not pass for lack of anything to inspect. This
  // reported "0 of 0 sections, 0 defects — clean" on a report that failed to
  // generate at all, which is the one result a guard must never give.
  if (!parts.length) {
    add('no-report', 'no sections at all — the report did not generate', 0, '');
  } else if (parts.length < expectedSections) {
    add('missing-section', `only ${parts.length} of ${expectedSections} sections present`, 0, '');
  }
  for (const heading of empty) {
    add('empty-section', 'section has no content', 0, heading);
  }

  return {
    defects,
    sections: { found: parts.length, expected: expectedSections, empty },
    ok: defects.length === 0
  };
};

/**
 * The idea lists have their own contract: two labelled halves, each filled, and
 * no agent claimed in both. Collapsing to a couple of entries happened twice.
 */
export const lintIdeaSections = (
  { researched = [], notStudied = [] } = {},
  { minPerSection = 10 } = {}
) => {
  const defects = [];
  // Compare on the leading term: "TUDCA" and "TUDCA (tauroursodeoxycholic
  // acid)" are one agent, and a slice of the whole string never matched them.
  const key = (name) => String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)[0] || '';
  if (researched.length < minPerSection) {
    defects.push({
      id: 'thin-researched',
      describe: `researched section has ${researched.length}, expected at least ${minPerSection}`
    });
  }
  if (notStudied.length < minPerSection) {
    defects.push({
      id: 'thin-not-studied',
      describe: `not-studied section has ${notStudied.length}, expected at least ${minPerSection}`
    });
  }
  const researchedKeys = new Set(researched.map(key).filter(Boolean));
  for (const name of notStudied) {
    if (researchedKeys.has(key(name))) {
      defects.push({
        id: 'agent-in-both-sections',
        describe: `"${name}" appears in both sections, so one card denies the study the other links`
      });
    }
  }
  return { defects, ok: defects.length === 0 };
};
