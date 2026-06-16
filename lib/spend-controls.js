// Spend kill switches — stop paid API calls without redeploying code.
//
// MRT_SPEND_ENABLED=0        Master off: no Anthropic/Perplexity on user runs
// MRT_RESEARCH_ENABLED=0     Search pipeline only (research/repurpose/trials)
// MRT_PERPLEXITY_ENABLED=0   Perplexity validation + web scout only
//
// Also see (already existed):
//   MRT_DYNAMIC_KB=0         Background KB builds (~$0.025 each)
//   MRT_BRAIN_CRON=0         Scheduled brain refresh
//   MRT_DISABLE_USAGE_LIMIT=0 + MRT_FREE_LIMIT=4  Cap free runs per IP
//   MRT_DOSSIER_CACHE=1      Cache dossier calls (repeat conditions free)
//
// Note: MRT_CONDITION_INFERENCE=0 is NOT a money saver — resolve/subtypes
// are local. It only stops silent rename-on-search.

import { isConditionInferenceEnabled, isConditionSubtypePickerEnabled } from './condition-intake-flags.js';

export const isSpendEnabled = () =>
  String(process.env.MRT_SPEND_ENABLED ?? '1').trim() !== '0';

export const isResearchPipelineEnabled = () =>
  isSpendEnabled() && String(process.env.MRT_RESEARCH_ENABLED ?? '1').trim() !== '0';

export const isPerplexitySpendEnabled = () =>
  isSpendEnabled() && String(process.env.MRT_PERPLEXITY_ENABLED ?? '1').trim() !== '0';

export const isDynamicKbSpendEnabled = () =>
  isSpendEnabled() && String(process.env.MRT_DYNAMIC_KB ?? '1').trim() !== '0';

export const isBrainCronEnabled = () =>
  isSpendEnabled() && String(process.env.MRT_BRAIN_CRON ?? '1').trim() !== '0';

/** Modes that call Anthropic (or equivalent) for user-facing output. */
export const isPaidUserMode = (mode) =>
  ['research', 'repurpose', 'trials', 'chat', 'translate'].includes(String(mode || '').trim());

export const spendControlsConfig = () => ({
  enabled: isSpendEnabled(),
  researchPipeline: isResearchPipelineEnabled(),
  perplexity: isPerplexitySpendEnabled(),
  dynamicKb: isDynamicKbSpendEnabled(),
  brainCron: isBrainCronEnabled(),
  conditionInference: isConditionInferenceEnabled(),
  subtypePicker: isConditionSubtypePickerEnabled(),
  usageLimitsEnabled: String(process.env.MRT_DISABLE_USAGE_LIMIT ?? '1').trim() !== '1'
});

export const spendDisabledMessage = () =>
  'Research is paused to stop API spending (MRT_SPEND_ENABLED=0 or MRT_RESEARCH_ENABLED=0 in Vercel). Turn it back on when you are ready.';
