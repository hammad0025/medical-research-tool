// Kill switch for smart condition intake (typo repair, ontology, gene notation,
// subtype picker, silent canonicalize-on-search). Default ON.
//
// This does NOT stop API spending — resolve/subtypes are local. For money,
// use MRT_SPEND_ENABLED=0 or MRT_RESEARCH_ENABLED=0 in lib/spend-controls.js.

export const isConditionInferenceEnabled = () =>
  String(process.env.MRT_CONDITION_INFERENCE ?? '1').trim() !== '0';

export const isConditionSubtypePickerEnabled = () =>
  isConditionInferenceEnabled() &&
  String(process.env.MRT_CONDITION_SUBTYPE_PICKER ?? '1').trim() !== '0';

export const conditionInferenceConfig = () => ({
  enabled: isConditionInferenceEnabled(),
  subtypePicker: isConditionSubtypePickerEnabled()
});
