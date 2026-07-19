// GET /api/health — platform readiness (no AI spend, no auth required when gate unset).

import { checkInfraStatus } from '../lib/infra-status.js';
import { listKbs } from '../lib/kb.js';
import { requireAccess } from '../lib/access-gate.js';
import { setSameOriginCors } from '../lib/cors.js';
import { requireTermsConsent } from '../lib/terms-consent.js';
import {
  REPURPOSE_LANE_COUNT,
  REPURPOSE_PER_LANE,
  REPURPOSE_SOFT_CAP,
  REPURPOSE_MIN_TOTAL,
  REPURPOSE_BACKFILL_THRESHOLD,
  REPURPOSE_TARGET_TOTAL
} from '../lib/repurpose-quality.js';
import { FAERS_SERIOUS_MIN_REPORTS } from '../lib/safety-score.js';
import { installPublicJsonBoundary } from '../lib/public-language.js';

export default async function handler(req, res) {
  installPublicJsonBoundary(res);
  if (!setSameOriginCors(req, res, {
    methods: 'GET,OPTIONS',
    headers: 'Content-Type, X-Access-Passcode'
  })) {
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'ORIGIN_BLOCKED' });
  }
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAccess(req, res)) return;
  if (!requireTermsConsent(req, res)) return;

  const infra = await checkInfraStatus();
  let kbCount = 0;
  let kbAvailable = true;
  try {
    kbCount = (await listKbs()).length;
  } catch (_) {
    kbAvailable = false;
  }

  const healthy = infra.productionReady && kbAvailable;
  const status = healthy ? 'healthy' : 'degraded';
  res.status(healthy ? 200 : 503).json({
    status,
    service: 'medical-research-tool',
    version: '3.0.0',
    deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    timestamp: new Date().toISOString(),
    platform: {
      maxFunctionDurationSec: 300,
      repurpose: {
        lanes: REPURPOSE_LANE_COUNT,
        perLane: REPURPOSE_PER_LANE,
        softCapCandidates: REPURPOSE_SOFT_CAP,
        minCandidates: REPURPOSE_MIN_TOTAL,
        hardFloorLinked: REPURPOSE_TARGET_TOTAL,
        backfillThreshold: REPURPOSE_BACKFILL_THRESHOLD,
        batchMaxTokensSonnet: 12000,
        groundingGated: true,
        realLinksOnly: true
      },
      gather: {
        repurposeSupplementQueries: true,
        supplementDiscoveryBlock: true
      },
      ratings: {
        efficacy: 'cited-outcome',
        safety: {
          representation: 'band',
          bands: ['Low', 'Moderate', 'High'],
          source: 'evidence-derived',
          deterministic: true,
          faersSeriousMinReports: FAERS_SERIOUS_MIN_REPORTS
        },
        confidence: {
          representation: 'band',
          bands: ['Low', 'Moderate', 'High'],
          requiresCitableEvidence: true,
          droppedWhenUnsourced: true
        }
      }
    },
    kb: { curatedConditions: kbCount, state: kbAvailable ? 'operational' : 'unavailable' },
    infra: {
      productionReady: healthy,
      ok: infra.ok,
      warnings: infra.warnings.map((w) => w.id),
      missing: infra.missing.map((m) => m.id),
      brainStore: infra.brainStore,
      usageMeteringEnabled: infra.usageMeteringEnabled,
      dependencies: Object.fromEntries(
        Object.entries(infra.dependencies).map(([name, dependency]) => [
          name,
          {
            required: dependency.required,
            configured: dependency.configured,
            state: dependency.state
          }
        ])
      )
    }
  });
}
