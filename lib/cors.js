const requestHost = (req) => String(
  req.headers?.host || ''
).split(',')[0].trim().toLowerCase();

const normalizedOrigin = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username || parsed.password || parsed.pathname !== '/' ||
        parsed.search || parsed.hash) return '';
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
};

const configuredOrigins = () => new Set(
  String(process.env.MRT_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizedOrigin)
    .filter(Boolean)
);

export const isAllowedRequestOrigin = (req) => {
  const rawOrigin = String(req.headers?.origin || '').trim();
  if (!rawOrigin) return true;
  const origin = normalizedOrigin(rawOrigin);
  if (!origin) return false;
  const allowlist = configuredOrigins();
  if (allowlist.size) return allowlist.has(origin);
  try {
    const parsed = new URL(origin);
    const host = requestHost(req);
    if (!host || parsed.host.toLowerCase() !== host) return false;
    const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host);
    return parsed.protocol === 'https:' || local;
  } catch {
    return false;
  }
};

export const setSameOriginCors = (req, res, {
  methods = 'GET,POST,OPTIONS',
  headers = 'Content-Type'
} = {}) => {
  const origin = String(req.headers?.origin || '').trim();
  const currentVary = String(res.getHeader?.('Vary') || '');
  const vary = new Set(currentVary.split(',').map((value) => value.trim()).filter(Boolean));
  vary.add('Origin');
  res.setHeader('Vary', [...vary].join(', '));
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
  if (!isAllowedRequestOrigin(req)) return false;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  return true;
};
