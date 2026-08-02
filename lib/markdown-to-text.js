// Markdown → readable plain text, for the .txt export.
//
// That export shipped the raw markdown, so a downloaded report contained
// "|---|---|---|" separator rows, "[label](https://…)" link syntax and "##"
// heading markers. Readable in a markdown viewer, noise in a text file — and
// the text export is the one a patient is most likely to paste into an email
// or hand to a clinician.

const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

const cells = (row) => String(row)
  .replace(/^\s*\|/, '')
  .replace(/\|\s*$/, '')
  .split('|')
  .map((cell) => cell.trim());

/** "[label](url)" → "label (url)"; a bare "[label]()" keeps just the label. */
const flattenLinks = (value) => String(value)
  .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (match, label, url) => {
    const text = label.replace(/\s*↗\s*$/, '').trim();
    return text ? `${text} (${url})` : url;
  })
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

const flattenEmphasis = (value) => String(value)
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:])/g, '$1$2');

export const markdownToPlainText = (markdown) => {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let pendingHeader = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    if (TABLE_SEPARATOR.test(line) && /\|/.test(lines[i - 1] || '')) {
      // The row above was the header; nothing to print for the separator.
      continue;
    }

    if (/^\s*\|/.test(line) && line.includes('|')) {
      const values = cells(line).map((cell) => flattenEmphasis(flattenLinks(cell)));
      const isHeader = TABLE_SEPARATOR.test(lines[i + 1] || '');
      if (isHeader) {
        pendingHeader = values;
        continue;
      }
      if (pendingHeader) {
        // Label each value with its column so a row still reads on its own.
        out.push(values
          .map((value, idx) => {
            const label = pendingHeader[idx];
            if (!value) return '';
            return label ? `${label}: ${value}` : value;
          })
          .filter(Boolean)
          .join(' | '));
      } else {
        out.push(values.filter(Boolean).join(' | '));
      }
      continue;
    }
    pendingHeader = null;

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const text = flattenEmphasis(flattenLinks(heading[2])).trim();
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(text);
      out.push((heading[1].length <= 2 ? '='.repeat(Math.min(text.length, 72)) : '-'.repeat(Math.min(text.length, 72))));
      continue;
    }

    if (/^\s*[-*]{3,}\s*$/.test(line)) {
      out.push('');
      continue;
    }

    out.push(flattenEmphasis(flattenLinks(line)));
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
