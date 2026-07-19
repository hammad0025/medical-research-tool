const CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f]/;
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i;

export const approvedUpgradeUrl = (value) => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || CONTROL_OR_WHITESPACE.test(candidate) || ENCODED_CONTROL.test(candidate)) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    CONTROL_OR_WHITESPACE.test(parsed.href)
  ) {
    return null;
  }
  return parsed.href;
};
