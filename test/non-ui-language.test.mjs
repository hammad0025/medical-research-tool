import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { INTERNAL_CALL } from '../lib/internal-call.js';
import {
  computeQualityFlags,
  countryAdjustment,
  scoreArticle
} from '../lib/evidence.js';
import {
  renderAlertHtml,
  renderAlertSubject
} from '../lib/alerts-email.js';
import { spendDisabledMessage } from '../lib/spend-controls.js';
import unpaywallHandler from '../lib/unpaywall.js';
import europePmcHandler from '../lib/europe-pmc.js';

const response = () => {
  const captured = { status: 200, body: undefined };
  return {
    captured,
    res: {
      setHeader() {},
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return this; },
      end() { return this; }
    }
  };
};

const digestFor = (firstAuthorCountry) => renderAlertHtml({
  sub: {
    condition: 'Example condition',
    patientContext: { age: '50', medications: 'Example medicine' }
  },
  condition: 'Example condition',
  newItems: [{
    title: 'Registered randomized study',
    journal: 'Example Journal',
    year: 2026,
    url: 'https://example.test/study',
    text: 'A study summary.',
    isRCT: true,
    isRegistered: true,
    protocolAvailable: true,
    firstAuthorCountry
  }],
  trials: [{
    nctId: 'NCT00000000',
    title: 'Example trial',
    overallStatus: 'RECRUITING',
    phases: ['PHASE2'],
    contacts: [{ name: 'Study contact' }]
  }],
  qualityBreakdown: {
    totalScreened: 1,
    retractedExcluded: 0,
    predatoryExcluded: 0
  }
});

test('nationality and country never change source integrity classification or email wording', () => {
  const base = {
    title: 'Same study',
    journal: 'Same journal',
    year: 2026,
    citedByCount: 12,
    isRCT: true,
    isRegistered: true,
    protocolAvailable: true
  };
  const countries = ['CN', 'US', 'IN', 'BR', 'DE', null];
  const classifications = countries.map((firstAuthorCountry) =>
    computeQualityFlags({ ...base, firstAuthorCountry })
  );
  const scores = countries.map((firstAuthorCountry) =>
    scoreArticle({ ...base, firstAuthorCountry })
  );

  classifications.slice(1).forEach((value) => assert.deepEqual(value, classifications[0]));
  scores.slice(1).forEach((value) => assert.equal(value, scores[0]));
  countries.forEach((firstAuthorCountry) =>
    assert.equal(countryAdjustment({ firstAuthorCountry }), 0)
  );

  assert.equal(digestFor('CN'), digestFor('US'));
  assert.equal(digestFor('IN'), digestFor(null));
});

test('alert email uses explicit study attributes and plain reader language', () => {
  const html = digestFor('CN');
  assert.match(html, /Randomized controlled trial/);
  assert.match(html, /Study registration reported/);
  assert.match(html, /Protocol available/);
  assert.match(html, /Phase 2 · Recruiting · Location not reported · Study contact listed/);
  assert.doesNotMatch(
    html,
    /first[- ]author|integrity concern.*(?:country|region)|geographic integrity|prompt pack|second AI|phase \?|status \?|country \?|highest-quality/i
  );

  const subject = renderAlertSubject({
    condition: 'Example condition',
    newItems: [{ isRCT: true }],
    trials: []
  });
  assert.match(subject, /randomized trial or evidence review/i);
  assert.doesNotMatch(subject, /\bRCT\b/);
});

test('public service-unavailable responses do not expose providers, configuration, or upstream bodies', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'upstream stack trace with API_KEY and storage host'
  });

  try {
    const fullText = response();
    await unpaywallHandler({
      [INTERNAL_CALL]: true,
      method: 'GET',
      query: { doi: '10.1000/example' },
      headers: {}
    }, fullText.res);
    assert.equal(fullText.captured.status, 503);
    assert.deepEqual(fullText.captured.body, {
      error: 'The full-text lookup service is temporarily unavailable.',
      code: 'FULL_TEXT_LOOKUP_UNAVAILABLE'
    });

    const literature = response();
    await europePmcHandler({
      [INTERNAL_CALL]: true,
      method: 'GET',
      query: { query: 'example condition' },
      headers: {}
    }, literature.res);
    assert.equal(literature.captured.status, 503);
    assert.deepEqual(literature.captured.body, {
      error: 'The literature search service is temporarily unavailable.',
      code: 'LITERATURE_SEARCH_UNAVAILABLE'
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('customer pause and access messages contain no deployment implementation details', async () => {
  assert.equal(spendDisabledMessage(), 'Research is temporarily unavailable. Please try again later.');

  const sources = await Promise.all([
    '../api/access-session.js',
    '../lib/access-gate.js',
    '../api/terms-consent.js',
    '../lib/terms-consent.js',
    '../api/alerts-subscribe.js'
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const publicSource = sources.join('\n');

  assert.doesNotMatch(
    publicSource,
    /Access control is not configured for this deployment|Terms consent enforcement is not configured for this deployment|Store is in-memory|Set UPSTASH|in Vercel to persist/
  );
  assert.match(publicSource, /private preview is temporarily unavailable/);
  assert.match(publicSource, /Terms acceptance service is temporarily unavailable/);
  assert.match(publicSource, /alert is temporary and may stop after the service restarts/);
});
