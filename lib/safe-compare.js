import { timingSafeEqual } from 'node:crypto';

// Constant-time string equality. Compares byte length first (unavoidable and
// non-secret) then defers to timingSafeEqual so a mismatch never leaks how many
// leading characters matched via timing. Shared by the access gate,
// terms-consent, and security enforcement so there is exactly one audited
// comparison for passcodes, tokens, and HMAC signatures — previously three
// byte-identical copies that could drift apart.
export const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
};
