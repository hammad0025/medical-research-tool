const readStringToken = (source, start) => {
  let escaped = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') return { token: source.slice(start, i + 1), end: i };
  }
  throw new SyntaxError('Unterminated JSON string');
};

export const assertNoDuplicateJsonKeys = (source) => {
  const text = String(source);
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const { token, end } = readStringToken(text, i);
      const current = stack[stack.length - 1];
      if (current?.type === 'object' && current.expectingKey) {
        const key = JSON.parse(token);
        if (current.keys.has(key)) {
          throw new SyntaxError(`Duplicate JSON key: ${key}`);
        }
        current.keys.add(key);
        current.expectingKey = false;
      }
      i = end;
      continue;
    }
    if (ch === '{') {
      stack.push({ type: 'object', keys: new Set(), expectingKey: true });
    } else if (ch === '[') {
      stack.push({ type: 'array' });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',') {
      const current = stack[stack.length - 1];
      if (current?.type === 'object') current.expectingKey = true;
    }
  }
};

export const parseJsonRejectDuplicates = (source) => {
  assertNoDuplicateJsonKeys(source);
  return JSON.parse(source);
};
