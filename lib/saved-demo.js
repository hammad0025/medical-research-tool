import { readFile } from 'node:fs/promises';
import {
  sealReportCompletion,
  verifyReportCompletionSeal
} from './report-completion.js';

export const SAVED_DEMO_SEAL_PURPOSE = 'saved-demo.provenance';

export const loadSavedDemo = async () =>
  JSON.parse(await readFile(
    new URL('../data/demo/saved-verified-report.json', import.meta.url),
    'utf8'
  ));

export const loadSavedDemoProfile = async (profileId) => {
  const fixture = JSON.parse(await readFile(
    new URL('../data/demo/golden-profiles.json', import.meta.url),
    'utf8'
  ));
  return fixture.profiles?.find((profile) => profile.id === profileId)?.patient || null;
};

export const savedDemoIdentity = (report) => ({
  schemaVersion: Number(report?.schemaVersion || 0),
  kind: String(report?.kind || ''),
  generatedAt: String(report?.generatedAt || ''),
  reviewedGitSha: String(report?.reviewedGitSha || ''),
  profileId: String(report?.profileId || ''),
  researchText: String(report?.researchText || ''),
  repurposeText: String(report?.repurposeText || ''),
  trials: report?.trials || null,
  audits: report?.audits || null
});

export const sealSavedDemo = (report, options = {}) =>
  sealReportCompletion(savedDemoIdentity(report), {
    ...options,
    purpose: SAVED_DEMO_SEAL_PURPOSE
  });

export const verifySavedDemo = (report, seal, options = {}) =>
  verifyReportCompletionSeal({
    contract: savedDemoIdentity(report),
    seal,
    ...options,
    purpose: SAVED_DEMO_SEAL_PURPOSE
  });

export const savedDemoMatchesCompletionInput = (report, input = {}) =>
  String(input?.sections?.research?.text || '') === String(report?.researchText || '') &&
  String(input?.sections?.repurpose?.text || '') === String(report?.repurposeText || '');
