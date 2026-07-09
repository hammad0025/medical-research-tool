// GET /api/health — platform readiness (no AI spend, no auth required when gate unset).

import { getInfraStatus } from '../lib/infra-status.js';
import { listKbs } from '../lib/kb.js';
import { requireAccess } from '../lib/access-gate.js';
import {
  REPURPOSE_LANE_COUNT,
  REPURPOSE_PER_LANE,
  REPURPOSE_SOFT_CAP,
  REPURPOSE_MIN_TOTAL,
  REPURPOSE_BACKFILL_THRESHOLD,
  REPURPOSE_TARGET_TOTAL
} from '../lib/repurpose-quality.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Passcode');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAccess(req, res)) return;

  const infra = getInfraStatus();
  let kbCount = 0;
  try {
    kbCount = (await listKbs()).length;
  } catch (_) {}

  const status = infra.productionReady ? 'healthy' : 'degraded';
  res.status(infra.productionReady ? 200 : 503).json({
    status,
    service: 'medical-research-tool',
    version: '3.0.0',
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
        batchMaxTokensSonnet: 7200,
        groundingGated: true,
        realLinksOnly: true
      },
      gather: {
        repurposeSupplementQueries: true,
        supplementDiscoveryBlock: true
      }
    },
    kb: { curatedConditions: kbCount },
    infra: {
      productionReady: infra.productionReady,
      ok: infra.ok,
      warnings: infra.warnings.map((w) => w.id),
      missing: infra.missing.map((m) => m.id),
      brainStore: infra.brainStore
    }
  });
}
