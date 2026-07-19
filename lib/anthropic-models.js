// Central Anthropic model defaults + fallback when the configured model 404s.
// Root cause of repeated "gather OK, synth failed": claude-sonnet-4-20250514 is
// not available on all API keys; gather often skips Claude (KB hit) but synth
// always calls Claude and dies with model not_found.

export const DEFAULT_RESEARCH_MODEL =
  process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-sonnet-4-6';

export const DEFAULT_DOSSIER_MODEL =
  process.env.ANTHROPIC_DOSSIER_MODEL || DEFAULT_RESEARCH_MODEL;

export const DEFAULT_TRANSLATE_MODEL =
  process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-3-5-haiku-20241022';

export const MODEL_FALLBACK_CHAIN = [
  DEFAULT_RESEARCH_MODEL,
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-3-5-haiku-20241022'
].filter((m, i, arr) => m && arr.indexOf(m) === i);

export const isModelNotFoundError = (status, errorData) =>
  status === 404 ||
  errorData?.error?.type === 'not_found_error' ||
  /model.*not/i.test(String(errorData?.error?.message || ''));

export const nextFallbackModel = (current) => {
  const chain = MODEL_FALLBACK_CHAIN;
  const idx = chain.indexOf(current);
  if (idx >= 0 && idx < chain.length - 1) return chain[idx + 1];
  if (idx === -1) return chain.find((m) => m !== current) || null;
  return null;
};

export const resolveResearchModel = (requested) => {
  const model = String(requested || '').trim();
  return MODEL_FALLBACK_CHAIN.includes(model) ? model : DEFAULT_RESEARCH_MODEL;
};
