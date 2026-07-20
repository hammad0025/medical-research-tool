import { createHash } from 'node:crypto';
import {
  canonicalizeReportContent,
  sealReportCompletion,
  verifyReportCompletionSeal
} from './report-completion.js';

export const REPORT_OUTPUT_PURPOSE = 'report-output.artifact';

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
};

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');

const normalizePatient = (patient) =>
  isPlainObject(patient)
    ? Object.fromEntries(
        Object.entries(patient).map(([key, value]) => [
          String(key),
          typeof value === 'string' ? value.trim() : value
        ])
      )
    : {};

const normalizeCoverage = (coverage) => {
  if (coverage?.status === 'not-applicable') return { status: 'not-applicable' };
  if (!isPlainObject(coverage)) return { status: 'not-applicable' };
  return {
    ...coverage,
    initialMissed: Array.isArray(coverage.initialMissed) ? coverage.initialMissed.map(String) : [],
    finalMissed: Array.isArray(coverage.finalMissed) ? coverage.finalMissed.map(String) : null
  };
};

export const createReportOutputArtifact = ({
  mode,
  stage = 'synthesis',
  segment = 'full',
  patient,
  text,
  validation = null,
  citationAudit = null,
  coverageAudit = null,
  evidenceDegraded = false
}, options = {}) => {
  const normalizedPatient = normalizePatient(patient);
  const payload = {
    version: 1,
    kind: 'live-report-output',
    mode: String(mode || ''),
    stage: String(stage || ''),
    segment: String(segment || ''),
    patient: normalizedPatient,
    patientFingerprint: digest(normalizedPatient),
    text: canonicalizeReportContent(text),
    validation: validation || null,
    citationAudit: citationAudit || null,
    coverageAudit: normalizeCoverage(coverageAudit),
    evidenceDegraded: evidenceDegraded === true
  };
  if (
    !['research', 'repurpose', 'trials'].includes(payload.mode) ||
    !['synthesis', 'final'].includes(payload.stage) ||
    !payload.text
  ) {
    const error = new Error('Invalid report output artifact');
    error.code = 'REPORT_OUTPUT_INVALID';
    throw error;
  }
  return {
    payload,
    seal: sealReportCompletion(payload, {
      ...options,
      purpose: REPORT_OUTPUT_PURPOSE
    })
  };
};

export const verifyReportOutputArtifact = (artifact, options = {}) => {
  const payload = artifact?.payload;
  if (
    !isPlainObject(payload) ||
    payload.version !== 1 ||
    payload.kind !== 'live-report-output' ||
    !['research', 'repurpose', 'trials'].includes(payload.mode) ||
    !['synthesis', 'final'].includes(payload.stage) ||
    !payload.text ||
    digest(normalizePatient(payload.patient)) !== payload.patientFingerprint
  ) {
    return { ok: false, code: 'REPORT_OUTPUT_INVALID' };
  }
  return verifyReportCompletionSeal({
    contract: payload,
    seal: artifact?.seal,
    ...options,
    purpose: REPORT_OUTPUT_PURPOSE
  });
};

const segmentOrder = (mode, segment) => {
  if (segment === 'full' || segment === 'final') return 0;
  if (mode === 'research') return segment === 'front' ? 10 : segment === 'back' ? 20 : 100;
  if (mode === 'repurpose') {
    const lane = String(segment).match(/^lane-(\d+)$/);
    if (lane) return 10 + Number(lane[1]);
    if (segment === 'front') return 50;
    if (segment === 'back') return 90;
  }
  return 100;
};

export const combineVerifiedReportArtifacts = (
  artifacts,
  { mode, now = Date.now(), secret } = {}
) => {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { ok: false, code: 'REPORT_OUTPUT_REQUIRED' };
  }
  const verified = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    const check = verifyReportOutputArtifact(artifact, { now, secret });
    if (!check.ok) return check;
    const payload = artifact.payload;
    if (payload.mode !== mode) return { ok: false, code: 'REPORT_OUTPUT_MODE_MISMATCH' };
    if (seen.has(payload.segment)) return { ok: false, code: 'REPORT_OUTPUT_DUPLICATE' };
    seen.add(payload.segment);
    verified.push(payload);
  }
  const fingerprints = new Set(verified.map((payload) => payload.patientFingerprint));
  if (fingerprints.size !== 1) return { ok: false, code: 'REPORT_OUTPUT_PROFILE_MISMATCH' };
  if (verified.some((payload) => payload.stage === 'final') && verified.length !== 1) {
    return { ok: false, code: 'REPORT_OUTPUT_CHAIN_INVALID' };
  }
  verified.sort((left, right) =>
    segmentOrder(mode, left.segment) - segmentOrder(mode, right.segment)
  );
  const finalMissed = verified.flatMap((payload) =>
    Array.isArray(payload.coverageAudit?.finalMissed)
      ? payload.coverageAudit.finalMissed
      : payload.coverageAudit?.status === 'not-applicable'
        ? []
        : ['Malformed coverage result']
  );
  const applicable = verified.some((payload) => payload.coverageAudit?.status !== 'not-applicable');
  return {
    ok: true,
    payloads: verified,
    patient: verified[0].patient,
    patientFingerprint: verified[0].patientFingerprint,
    text: verified.map((payload) => payload.text).join('\n\n'),
    coverageAudit: applicable
      ? { finalMissed: [...new Set(finalMissed)] }
      : { status: 'not-applicable' },
    citationAudit: verified.some((payload) => payload.citationAudit?.status === 'failed')
      ? { status: 'failed' }
      : verified.some((payload) => payload.citationAudit?.status === 'degraded')
        ? { status: 'degraded' }
        : { status: 'passed' },
    evidenceDegraded: verified.some((payload) => payload.evidenceDegraded)
  };
};
