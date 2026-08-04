import { requireAccess } from '../lib/access-gate.js';
import { setSameOriginCors } from '../lib/cors.js';
import {
  assessReportCompletion,
  bindReportContent,
  isReportSealMisconfigured,
  sealReportCompletion,
  verifyReportContentBinding
} from '../lib/report-completion.js';
import {
  loadSavedDemo,
  loadSavedDemoProfile,
  verifySavedDemo
} from '../lib/saved-demo.js';
import { combineVerifiedReportArtifacts } from '../lib/report-artifact.js';
import { buildCanonicalReportSurface } from '../lib/report-surface.js';
import { verifyTrialRegistryPayload } from '../lib/trial-registry-gate.js';
import { conditionsResolveToSameIdentity } from '../lib/condition-resolver.js';
import { hasTermsConsent, requireTermsConsent } from '../lib/terms-consent.js';
import { requireJsonObjectBody } from '../lib/request-boundary.js';
import { installPublicJsonBoundary } from '../lib/public-language.js';

export default async function handler(req, res) {
  installPublicJsonBoundary(res);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (!setSameOriginCors(req, res, {
    methods: 'POST,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAccess(req, res) || !requireTermsConsent(req, res)) return;
  if (isReportSealMisconfigured()) {
    return res.status(503).json({
      error: 'Report sealing is not configured for this deployment.',
      code: 'REPORT_SEAL_CONFIG'
    });
  }

  // Matches the 3.5 MB the research endpoint already accepts. This body carries
  // both signed report artifacts plus the trial payload, and each artifact
  // embeds the full section text it signs. Once the repurpose lanes started
  // issuing their artifact — they previously issued none, which is what made
  // completion answer 409 — an IPF report crossed the old 1 MB ceiling and
  // completion answered 413 instead. Every byte here is server-issued and
  // signature-checked below.
  const body = requireJsonObjectBody(req, res, { maxBytes: Math.floor(3.5 * 1024 * 1024) });
  if (!body) return;
  const surface = String(body.surface || '');
  if (!['research', 'repurpose', 'full'].includes(surface)) {
    return res.status(400).json({
      error: 'A supported report surface is required.',
      code: 'REPORT_SURFACE_REQUIRED'
    });
  }

  let savedDemoProvenance = null;
  let completionInput;
  let reportContent = '';
  const savedDemoSeal = String(body?.savedDemo?.provenanceSeal || '');
  if (savedDemoSeal) {
    const savedDemo = await loadSavedDemo();
    const provenance = verifySavedDemo(savedDemo, savedDemoSeal);
    const patient = await loadSavedDemoProfile(savedDemo.profileId);
    if (!provenance.ok || !patient) {
      return res.status(409).json({
        error: 'The saved example could not be verified.',
        code: 'SAVED_DEMO_PROVENANCE_INVALID'
      });
    }
    savedDemoProvenance = {
      kind: savedDemo.kind,
      generatedAt: savedDemo.generatedAt,
      reviewedGitSha: savedDemo.reviewedGitSha
    };
    completionInput = {
      profileKey: `saved-demo:${savedDemo.profileId}`,
      termsVersion: body.termsVersion,
      sections: {
        research: {
          text: savedDemo.researchText,
          profileKey: `saved-demo:${savedDemo.profileId}`
        },
        repurpose: {
          text: savedDemo.repurposeText,
          profileKey: `saved-demo:${savedDemo.profileId}`
        }
      },
      trials: {
        status: savedDemo.trials?.status || 'empty',
        profileKey: `saved-demo:${savedDemo.profileId}`
      },
      audits: savedDemo.audits
    };
    reportContent = buildCanonicalReportSurface({
      surface,
      patient,
      researchText: savedDemo.researchText,
      repurposeText: savedDemo.repurposeText,
      trials: savedDemo.trials
    });
  } else {
    const research = combineVerifiedReportArtifacts(
      body?.artifacts?.research ? [body.artifacts.research] : [],
      { mode: 'research' }
    );
    const repurpose = combineVerifiedReportArtifacts(
      body?.artifacts?.repurpose ? [body.artifacts.repurpose] : [],
      { mode: 'repurpose' }
    );
    if (!research.ok || !repurpose.ok) {
      return res.status(409).json({
        error: 'The report sections were not issued by the server.',
        code: !research.ok ? research.code : repurpose.code
      });
    }
    if (research.patientFingerprint !== repurpose.patientFingerprint) {
      return res.status(409).json({
        error: 'The report sections belong to different profiles.',
        code: 'REPORT_OUTPUT_PROFILE_MISMATCH'
      });
    }
    const trialsPayload = body.trialsPayload;
    const trialsCheck = verifyTrialRegistryPayload(trialsPayload);
    if (!trialsCheck.ok) {
      return res.status(409).json({
        error: 'The clinical-trial results were not issued by the server.',
        code: 'TRIAL_REGISTRY_DATA_INVALID'
      });
    }
    const conditionMatches = await conditionsResolveToSameIdentity(
      research.patient?.condition,
      trialsPayload?.query?.condition
    );
    if (!conditionMatches) {
      return res.status(409).json({
        error: 'The clinical-trial results belong to a different condition.',
        code: 'TRIAL_PROFILE_MISMATCH'
      });
    }
    const profileKey = research.patientFingerprint;
    const researchPayload = research.payloads[0];
    const repurposePayload = repurpose.payloads[0];
    const finalMissed = [
      ...(Array.isArray(researchPayload.coverageAudit?.finalMissed)
        ? researchPayload.coverageAudit.finalMissed
        : []),
      ...(Array.isArray(repurposePayload.coverageAudit?.finalMissed)
        ? repurposePayload.coverageAudit.finalMissed
        : [])
    ];
    const applicableCoverage =
      researchPayload.coverageAudit?.status !== 'not-applicable' ||
      repurposePayload.coverageAudit?.status !== 'not-applicable';
    completionInput = {
      profileKey,
      termsVersion: body.termsVersion,
      sections: {
        research: { text: research.text, profileKey },
        repurpose: { text: repurpose.text, profileKey }
      },
      trials: {
        status: trialsPayload.status === 'cancelled' || trialsPayload.cancelled
          ? 'cancelled'
          : trialsPayload.degraded || trialsPayload.providerErrors?.length
            ? 'degraded'
            : Array.isArray(trialsPayload.studies) && trialsPayload.studies.length
              ? 'complete'
              : 'empty',
        profileKey
      },
      audits: {
        validation: {
          research: researchPayload.validation,
          repurpose: repurposePayload.validation
        },
        citations: {
          research: researchPayload.citationAudit,
          repurpose: repurposePayload.citationAudit
        },
        coverage: applicableCoverage
          ? { finalMissed: [...new Set(finalMissed)] }
          : { status: 'not-applicable' }
      },
      evidenceDegraded:
        researchPayload.evidenceDegraded === true ||
        repurposePayload.evidenceDegraded === true
    };
    reportContent = buildCanonicalReportSurface({
      surface,
      patient: research.patient,
      researchText: research.text,
      repurposeText: repurpose.text,
      trials: trialsPayload
    });
  }

  const contract = assessReportCompletion({
    ...completionInput,
    outputQualityVersion: '1'
  }, {
    termsAccepted: hasTermsConsent(req),
    savedDemoProvenance
  });
  const now = Date.now();
  const sealed = bindReportContent({
    ...contract,
    issuedAt: new Date(now).toISOString()
  }, reportContent);
  const seal = sealReportCompletion(sealed, { now });
  const verification = verifyReportContentBinding({
    contract: sealed,
    seal,
    reportContent,
    now
  });
  if (!verification.ok) {
    return res.status(503).json({
      error: 'Report sealing verification failed.',
      code: verification.code || 'REPORT_SEAL_INVALID'
    });
  }
  return res.status(contract.eligible ? 200 : 409).json({
    contract: sealed,
    seal,
    canonicalContent: reportContent
  });
}
