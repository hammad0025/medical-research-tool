import { sanitizePublicText } from './public-language.js';

const SECRET_KEY = /(?:authorization|api[-_]?key|token|secret|passcode|password|cookie|session|ownerToken|unsubscribeToken)/i;
const SENSITIVE_KEY = /(?:patient|profile|chatHistory|userQuery|priorText|email|address|phone|mrn|diagnos|medication|allerg|symptom|lab|scan|genetic)/i;

const redactText = (value) => String(value ?? '')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
  .replace(/\b(?:sk|pk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_SECRET]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
  .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_NUMBER]')
  .slice(0, 500);

export const redactSensitive = (value, depth = 0) => {
  if (depth > 4) return '[REDACTED_DEPTH]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) {
    return {
      name: redactText(value.name || 'Error'),
      code: redactText(value.code || ''),
      message: redactText(value.message || 'Operation failed')
    };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactSensitive(item, depth + 1));
  if (typeof value !== 'object') return redactText(value);

  const clean = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    if (SECRET_KEY.test(key) || SENSITIVE_KEY.test(key)) clean[key] = '[REDACTED]';
    else clean[key] = redactSensitive(entry, depth + 1);
  }
  return clean;
};

export const safeErrorMessage = (error, fallback = 'Operation failed') =>
  redactText(error?.message || fallback);

export const logError = (label, error, context = null) => {
  const record = {
    error: redactSensitive(error),
    ...(context == null ? {} : { context: redactSensitive(context) })
  };
  console.error(String(label || '[error]'), record);
};

export const publicError = (message = 'The service encountered an unexpected problem.', code = 'INTERNAL_ERROR') => ({
  error: sanitizePublicText(message),
  code: ['INTERNAL_ERROR', 'PUBLIC_REQUEST_FAILED'].includes(String(code || ''))
    ? code
    : 'PUBLIC_REQUEST_FAILED'
});
