export const classifyAccessProbeResponse = ({ status, code, error } = {}) => {
  if (status === 401 && code === 'ACCESS_GATE_BLOCKED') {
    return { ok: false, gateEnabled: true, reason: error || 'Access denied.' };
  }
  if (status === 428 && code === 'TERMS_ACCEPTANCE_REQUIRED') {
    return { ok: true, gateEnabled: true, termsRequired: true };
  }
  if (Number(status) >= 200 && Number(status) < 300) {
    return { ok: true, gateEnabled: false };
  }
  return {
    ok: false,
    gateEnabled: true,
    reason: 'Access could not be verified because the service is temporarily unavailable.'
  };
};
