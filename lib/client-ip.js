// Best-effort client IP for rate-limiting and security logging. Trusts the
// first x-forwarded-for hop (set by the platform edge), then x-real-ip, then
// the raw socket address. Lower-cased and trimmed so the same client keys
// consistently. Shared by the access rate limiter and security enforcement.
export const clientIp = (req) => String(
  req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] ||
  req.socket?.remoteAddress || 'unknown'
).split(',')[0].trim().toLowerCase();
