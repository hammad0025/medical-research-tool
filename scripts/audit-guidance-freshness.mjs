#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessGuidanceFreshness,
  classifyGuidanceSource
} from '../lib/guidance-freshness-gate.js';
import { probeUrl } from '../lib/link-check.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = join(ROOT, 'data', 'kb');
const LIVE = process.argv.includes('--live');
const jsonIndex = process.argv.indexOf('--json');
const JSON_OUT = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : '';
const NOW_ARG = process.argv.find((arg) => arg.startsWith('--now='));
const NOW = NOW_ARG ? new Date(NOW_ARG.slice('--now='.length)) : new Date();

const recordsFromKb = (kb, slug) => {
  const groups = [
    ['item', kb.items],
    ['canonicalFact', kb.canonicalFacts],
    ['lifestyle', kb.lifestyleRecommendations],
    ['pipelineDrug', kb.pipelineDrugs],
    ['reference', kb.references]
  ];
  return groups.flatMap(([kind, rows]) => (rows || []).map((row, index) => ({
    ...row,
    isCuratedKB: true,
    kbCondition: kb.condition,
    _audit: { slug, kind, index, id: row?.id || row?.title || null }
  })));
};

const main = async () => {
  const files = readdirSync(KB_DIR).filter((name) =>
    name.endsWith('.json') && !name.startsWith('_'));
  const rows = files.flatMap((name) => {
    const kb = JSON.parse(readFileSync(join(KB_DIR, name), 'utf8'));
    return recordsFromKb(kb, name.replace(/\.json$/, ''));
  });
  const guidance = rows.filter((row) => classifyGuidanceSource(row).isGuidance);
  const findings = [];
  const reasons = {};
  let accepted = 0;
  let redirectsChecked = 0;

  for (const row of guidance) {
    let finalUrl = '';
    if (LIVE) {
      const url = row.canonicalUrl || row.url || row.dailyMedUrl || '';
      if (url) {
        const probe = await probeUrl(url, Number(process.env.MRT_LINKCHECK_TIMEOUT_MS || 8000));
        if (!probe.dead) {
          finalUrl = probe.finalUrl || url;
          redirectsChecked += 1;
        }
      }
    }
    const assessment = assessGuidanceFreshness(row, { now: NOW, finalUrl });
    if (assessment.ok) {
      accepted += 1;
      continue;
    }
    reasons[assessment.reason] = (reasons[assessment.reason] || 0) + 1;
    findings.push({
      ...row._audit,
      url: row.canonicalUrl || row.url || row.dailyMedUrl || null,
      reason: assessment.reason,
      classification: assessment.classification,
      governingDate: assessment.governingDate || null,
      versionIdentifier: assessment.versionIdentifier || null,
      finalUrl: assessment.finalUrl || finalUrl || null
    });
  }

  const report = {
    schema: 'mrt.guidance-freshness-audit.v1',
    checkedAt: NOW.toISOString(),
    mode: LIVE ? 'live' : 'static',
    conditions: files.length,
    evaluatedRows: rows.length,
    stableNonGuidanceRows: rows.length - guidance.length,
    guidanceRows: guidance.length,
    acceptedGuidance: accepted,
    rejectedGuidance: findings.length,
    redirectsChecked,
    reasons,
    findings
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (JSON_OUT) {
    const output = join(ROOT, JSON_OUT);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized);
  }
  console.log(serialized.trim());
  if (findings.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`Guidance freshness audit failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
