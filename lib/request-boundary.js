import { parseJsonRejectDuplicates } from './strict-json.js';

const byteLength = (value) => Buffer.byteLength(String(value || ''), 'utf8');
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i;

const inspectShape = (value, {
  maxDepth,
  maxArrayItems,
  maxObjectKeys,
  maxStringBytes,
  maxNodes
}) => {
  let nodes = 0;
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > maxNodes) return 'Request body has too many nested values';
    if (current.depth > maxDepth) return 'Request body is nested too deeply';
    if (typeof current.value === 'string' && byteLength(current.value) > maxStringBytes) {
      return 'Request body contains an oversized text value';
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > maxArrayItems) return 'Request body contains an oversized array';
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === 'object') {
      const entries = Object.entries(current.value);
      if (entries.length > maxObjectKeys) return 'Request body contains an oversized object';
      for (const [, item] of entries) stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return null;
};

export const requireJsonObjectBody = (req, res, {
  maxBytes = 256 * 1024,
  allowEmpty = false,
  maxDepth = 20,
  maxArrayItems = 1_000,
  maxObjectKeys = 500,
  maxStringBytes = 256 * 1024,
  maxNodes = 10_000
} = {}) => {
  const header = req.headers?.['content-type'] ?? req.headers?.['Content-Type'];
  const contentType = String(Array.isArray(header) ? header[0] : header || '').trim();
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    res.status(415).json({
      error: 'Content-Type must be application/json',
      code: 'UNSUPPORTED_MEDIA_TYPE'
    });
    return null;
  }
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.status(413).json({ error: 'Request body too large', code: 'REQUEST_BODY_TOO_LARGE' });
    return null;
  }

  let body = req.body;
  const raw = req.rawBody;
  const rawSource = typeof raw === 'string' || Buffer.isBuffer(raw)
    ? String(raw)
    : typeof body === 'string' || Buffer.isBuffer(body)
      ? String(body)
      : null;
  if (rawSource != null) {
    if (byteLength(rawSource) > maxBytes) {
      res.status(413).json({ error: 'Request body too large', code: 'REQUEST_BODY_TOO_LARGE' });
      return null;
    }
    if (!rawSource.trim() && allowEmpty) return {};
    try {
      body = parseJsonRejectDuplicates(rawSource);
    } catch (error) {
      const duplicate = /Duplicate JSON key:/.test(String(error?.message || ''));
      res.status(400).json({
        error: duplicate ? 'Request body contains a duplicate JSON key' : 'Request body must be valid JSON',
        code: duplicate ? 'DUPLICATE_JSON_KEY' : 'INVALID_JSON'
      });
      return null;
    }
  }

  if (body == null && allowEmpty) return {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Request body must be a JSON object', code: 'INVALID_REQUEST_BODY' });
    return null;
  }

  let measured;
  try {
    measured = byteLength(JSON.stringify(body));
  } catch {
    res.status(400).json({ error: 'Request body must be serializable JSON', code: 'INVALID_REQUEST_BODY' });
    return null;
  }
  if (measured > maxBytes) {
    res.status(413).json({ error: 'Request body too large', code: 'REQUEST_BODY_TOO_LARGE' });
    return null;
  }
  const shapeError = inspectShape(body, {
    maxDepth,
    maxArrayItems,
    maxObjectKeys,
    maxStringBytes,
    maxNodes
  });
  if (shapeError) {
    res.status(413).json({ error: shapeError, code: 'REQUEST_BODY_TOO_LARGE' });
    return null;
  }
  return body;
};
