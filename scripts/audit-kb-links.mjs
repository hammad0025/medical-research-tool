#!/usr/bin/env node
// ALL-CONDITIONS KB LINK AUDIT + regression gate.
//
// Dorothy mandate: every curated condition KB must only pin URLs that are
// actually openable. Search placeholders (Google / PubMed ?term= / CT.gov
// search / DailyMed search) are banned. Live HTTP probes fail the suite on
// definitive 404/410/dud paywalls.
//
// Run:
//   node scripts/audit-kb-links.mjs            # static bans + live probe
//   node scripts/audit-kb-links.mjs --static   # banned patterns only (CI-fast)
//   node scripts/audit-kb-links.mjs --json out.json
//
// Wired into `npm run regression` so dead/banned cites cannot ship silently.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findDeadLinks, extractReportUrls } from '../lib/link-check.js';
import { isBannedClaimCitation, isDailyMedSearchUrl, isGoogleSearchUrl } from '../lib/citation-gate.js';
import { preferVerifiableUrl } from '../lib/report-polish.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KB_DIR = join(ROOT, 'data', 'kb');
const STATIC_ONLY = process.argv.includes('--static');
const jsonOutIdx = process.argv.indexOf('--json');
const JSON_OUT = jsonOutIdx >= 0 ? process.argv[jsonOutIdx + 1] : null;

const pass = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[31m✗\x1b[0m ${m}`); process.exitCode = 1; };
const info = (m) => console.log(`  ${m}`);

// Prefer reader-verifiable hosts for pinned paper URLs. Publisher paywalls
// (NEJM / Lancet / Science / AAO / ATS journals) routinely 403 bots and
// readers — pin PubMed / DOI / PMC / CT.gov / FDA / DailyMed setid instead.
const PREFERRED_CITE_HOST =
  /pubmed\.ncbi\.nlm\.nih\.gov\/\d|doi\.org\/10\.|ncbi\.nlm\.nih\.gov\/pmc\/|pmc\.ncbi\.nlm\.nih\.gov\/articles\/|clinicaltrials\.gov\/study\/|accessdata\.fda\.gov\/scripts\/cder\/daf\/|dailymed\.nlm\.nih\.gov\/dailymed\/drugInfo\.cfm\?setid=/i;

// Provenance URLs skipped by the liveness probe, reported so an exemption is
// never silent. Populated by extractKbCitationUrls.
const PROVENANCE_KIND = 'provenance';
const RESOURCE_KIND = 'resource';
const RESOURCE_ARRAYS = ['patientAdvocacy', 'topCenters', 'keyInvestigators'];
const exemptedProvenanceUrls = [];

/** Collect every citeable URL a KB can inject into an evidence pack. */
export const extractKbCitationUrls = (kb, slug = '') => {
  const urls = new Set();
  const add = (u, meta = {}) => {
    const s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) return;
    const clean = s.replace(/[.,;:!?)]+$/, '');
    urls.add(JSON.stringify({ url: clean, slug, ...meta }));
  };

  const addFromItem = (item, kind) => {
    if (!item || typeof item !== 'object') return;
    if (item.quarantined === true) return;
    const preferred = preferVerifiableUrl(item, item.url || '');
    if (preferred) add(preferred, { kind, id: item.id || item.name || '' });
    for (const f of ['url', 'link', 'pmcUrl', 'pubmedUrl', 'doiUrl', 'sourceUrl', 'fullTextUrl', 'dailyMedUrl', 'evidenceUrl']) {
      if (item[f]) add(item[f], { kind, field: f, id: item.id || item.name || '' });
    }
    if (item.pmid) {
      const id = String(item.pmid).replace(/\D/g, '');
      if (id) add(`https://pubmed.ncbi.nlm.nih.gov/${id}/`, { kind, field: 'pmid', id: item.id || item.name || '' });
    }
    if (item.doi) {
      const doi = String(item.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
      if (doi) add(`https://doi.org/${doi}`, { kind, field: 'doi', id: item.id || item.name || '' });
    }
    if (item.nct || item.nctId) {
      const nct = String(item.nct || item.nctId).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (/^NCT\d{8}$/.test(nct)) {
        add(`https://clinicaltrials.gov/study/${nct}`, { kind, field: 'nct', id: item.id || item.name || '' });
      }
    }
    // Free-text fields may embed markdown links.
    for (const f of ['summary', 'status', 'mechanism', 'claim', 'recommendation', 'reason', 'notes']) {
      if (typeof item[f] === 'string') {
        for (const u of extractReportUrls(item[f])) add(u, { kind, field: f, id: item.id || item.name || '' });
      }
    }
    for (const p of item.keyPassages || []) {
      if (p?.quote) for (const u of extractReportUrls(p.quote)) add(u, { kind: `${kind}.keyPassage`, id: item.id });
    }
  };

  for (const it of kb.items || []) addFromItem(it, 'item');
  for (const d of kb.pipelineDrugs || []) addFromItem(d, 'pipelineDrug');
  for (const a of kb.excludedAgents || []) addFromItem(a, 'excludedAgent');
  for (const c of kb.canonicalFacts || []) {
    addFromItem(c, 'canonicalFact');
    if (c.evidenceUrl) add(c.evidenceUrl, { kind: 'canonicalFact', id: c.claim?.slice(0, 40) });
  }
  for (const l of kb.lifestyleRecommendations || []) addFromItem(l, 'lifestyle');
  for (const r of kb.redFlags || []) {
    if (typeof r === 'string') for (const u of extractReportUrls(r)) add(u, { kind: 'redFlag' });
    else addFromItem(r, 'redFlag');
  }
  for (const r of kb.references || []) addFromItem(r, 'reference');

  // Organisation front doors — advocacy groups, centres, investigator pages.
  // These are resources for the reader, not evidence behind a medical claim,
  // so they are held to "definitively gone" rather than "answered our bot".
  for (const key of RESOURCE_ARRAYS) {
    for (const entry of kb[key] || []) {
      if (!entry || typeof entry !== 'object') continue;
      for (const field of ['url', 'website', 'link']) {
        if (entry[field]) {
          add(entry[field], { kind: RESOURCE_KIND, field, id: entry.name || entry.center || '' });
        }
      }
    }
  }

  // Also scrape any leftover https in the raw JSON (belt + suspenders).
  //
  // `canonicalUrl` records WHERE a guideline officially lives — the society's
  // or publisher's own page. It is provenance, not a citation: no reader is
  // ever sent there, because VERIFIABLE_URL_FIELDS excludes it and
  // preferVerifiableUrl cites the item's pmid/doi instead. Publisher pages
  // 403 an automated probe as a matter of course, so scraping them into the
  // liveness check failed this audit every night over links no report can
  // emit — and there was no way to "fix" the data without falsifying where
  // the guideline actually lives.
  //
  // Exempt it ONLY when the item carries the identifier the reader will
  // actually be handed. With no pmid/doi, canonicalUrl IS the citation and
  // must still resolve.
  // The exemption is from the LIVENESS PROBE only. These URLs stay in the
  // index under kind 'provenance' so the banned-pattern scan still sees them —
  // a canonicalUrl pointing at a Google search must fail the audit like any
  // other citation.
  const provenanceExempt = [];
  const liftProvenanceUrls = (node) => {
    if (Array.isArray(node)) return node.map(liftProvenanceUrls);
    if (!node || typeof node !== 'object') return node;
    const copy = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'canonicalUrl' && (node.pmid || node.doi)) {
        const url = String(value || '');
        provenanceExempt.push({ slug, id: node.id || '', url });
        add(url, { kind: PROVENANCE_KIND, field: 'canonicalUrl', id: node.id || '' });
        continue;
      }
      copy[key] = liftProvenanceUrls(value);
    }
    return copy;
  };
  // Resource front doors were tagged above; drop just the fields that were
  // lifted so the sweep cannot re-add the same URL untagged (any OTHER url in
  // those entries is still swept and still probed strictly).
  const withoutLiftedResourceUrls = Object.fromEntries(
    RESOURCE_ARRAYS
      .filter((key) => Array.isArray(kb[key]))
      .map((key) => [
        key,
        kb[key].map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const { url, website, link, ...rest } = entry;
          return rest;
        })
      ])
  );
  const raw = JSON.stringify(liftProvenanceUrls({
    ...kb,
    items: (kb.items || []).filter((item) => item?.quarantined !== true),
    ...withoutLiftedResourceUrls
  }));
  exemptedProvenanceUrls.push(...provenanceExempt);
  const bare = raw.match(/https?:\\\/\\\/[^"\\]+/g) || [];
  for (const esc of bare) {
    const u = esc.replace(/\\\//g, '/');
    add(u, { kind: 'raw-json' });
  }
  const bare2 = raw.match(/https?:\/\/[^"\s]+/g) || [];
  for (const u of bare2) add(u, { kind: 'raw-json' });

  return [...urls].map((s) => JSON.parse(s));
};

const loadAllKbs = () => {
  const files = readdirSync(KB_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  return files.map((f) => {
    const slug = f.replace(/\.json$/, '');
    const kb = JSON.parse(readFileSync(join(KB_DIR, f), 'utf8'));
    return { slug, file: f, kb };
  });
};

const main = async () => {
  const kbs = loadAllKbs();
  console.log(`\nKB link audit — ${kbs.length} conditions\n`);

  const bySlug = {};
  const urlIndex = new Map(); // url -> [{slug, kind, id}]
  let totalCitations = 0;

  for (const { slug, kb } of kbs) {
    const cites = extractKbCitationUrls(kb, slug);
    bySlug[slug] = cites;
    totalCitations += cites.length;
    for (const c of cites) {
      if (!urlIndex.has(c.url)) urlIndex.set(c.url, []);
      urlIndex.get(c.url).push({ slug, kind: c.kind, id: c.id || '' });
    }
  }

  const uniqueUrls = [...urlIndex.keys()];
  // Probe everything except URLs that appear ONLY as provenance. The same URL
  // pinned as a real citation anywhere else is still probed.
  const probeUrls = uniqueUrls.filter((url) =>
    (urlIndex.get(url) || []).some((ref) => ref.kind !== PROVENANCE_KIND)
  );
  // A URL cited anywhere as evidence is judged strictly, even if it also
  // appears as an organisation link.
  const citationUrls = probeUrls.filter((url) =>
    (urlIndex.get(url) || []).some((ref) => ref.kind !== RESOURCE_KIND)
  );
  const resourceUrls = probeUrls.filter((url) => !citationUrls.includes(url));
  pass(`Extracted ${totalCitations} citation refs → ${uniqueUrls.length} unique URLs across ${kbs.length} KBs`);

  // The provenance exemption above is only sound while the reader really is
  // handed a resolving link instead. Prove it per item rather than trusting it:
  // every exempted canonicalUrl must belong to an item whose rendered citation
  // is a preferred, reader-verifiable host.
  const unbackedExemptions = [];
  for (const { slug, kb } of kbs) {
    for (const item of kb.items || []) {
      if (!item?.canonicalUrl || !(item.pmid || item.doi)) continue;
      const rendered = preferVerifiableUrl(item, item.url || '');
      if (!PREFERRED_CITE_HOST.test(String(rendered || ''))) {
        unbackedExemptions.push(`[${slug}] ${item.id || item.title || ''} → ${rendered || 'no citeable URL'}`);
      }
    }
  }
  if (unbackedExemptions.length) {
    fail(`${unbackedExemptions.length} item(s) hide a publisher canonicalUrl without a reader-verifiable citation`);
    unbackedExemptions.slice(0, 8).forEach((line) => info(line));
  } else if (exemptedProvenanceUrls.length) {
    pass(
      `${exemptedProvenanceUrls.length} provenance canonicalUrl(s) exempt from the probe — ` +
      'each item cites a resolving PubMed/DOI record instead'
    );
  }

  // --- Static banned patterns (must be zero) ---
  const banned = uniqueUrls.filter((u) => isBannedClaimCitation(u));
  if (banned.length === 0) {
    pass('No banned claim citations in any KB (Google / PubMed-search / CT-search / DailyMed-search / known-dead)');
  } else {
    fail(`${banned.length} banned citation URL(s) pinned in KBs:`);
    for (const u of banned) {
      const where = urlIndex.get(u).map((x) => `${x.slug}:${x.kind}`).slice(0, 6).join(', ');
      info(`BANNED ${u}`);
      info(`  ← ${where}`);
    }
  }

  // Per-condition emptiness check — every KB should pin at least one citeable URL
  // (pmid-derived PubMed or explicit url). Thin KBs are a quality smell.
  const empty = kbs.filter(({ slug }) => (bySlug[slug] || []).length === 0);
  if (empty.length === 0) {
    pass(`Every condition KB pins ≥1 citeable URL (${kbs.length}/${kbs.length})`);
  } else {
    fail(`${empty.length} KB(s) have ZERO citeable URLs: ${empty.map((e) => e.slug).join(', ')}`);
  }

  // Explicit per-condition static test: each condition's URLs individually checked
  let conditionsWithBanned = 0;
  for (const { slug } of kbs) {
    const bad = (bySlug[slug] || []).filter((c) => isBannedClaimCitation(c.url));
    if (bad.length) {
      conditionsWithBanned++;
      fail(`[${slug}] ${bad.length} banned URL(s)`);
      bad.slice(0, 3).forEach((c) => info(`  ${c.url}`));
    }
  }
  if (!conditionsWithBanned) {
    pass(`Per-condition banned-URL scan clean (${kbs.length} conditions)`);
  }

  let publisherPins = 0;
  for (const { slug, kb } of kbs) {
    for (const it of kb.items || []) {
      const u = String(it.url || '');
      if (!/^https?:\/\//i.test(u)) continue;
      if (PREFERRED_CITE_HOST.test(u)) continue;
      if (it.pmid || it.doi) {
        // Has identifiers — should have used preferVerifiableUrl. Count as smell.
        publisherPins++;
        if (publisherPins <= 8) {
          info(`[${slug}] publisher URL with pmid/doi available — prefer PubMed/DOI: ${u.slice(0, 80)}`);
        }
      }
    }
  }
  if (publisherPins === 0) {
    pass('No publisher paywall URLs pinned when pmid/doi is available');
  } else {
    fail(`${publisherPins} item(s) pin publisher paywall URLs despite pmid/doi — rewrite to PubMed/DOI`);
  }

  // --- Live probe (unless --static) ---
  let deadList = [];
  const probeDetails = new Map();
  if (!STATIC_ONLY) {
    console.log(
      `\nLive-probing ${citationUrls.length} citation + ${resourceUrls.length} resource URLs ` +
      `(${uniqueUrls.length - probeUrls.length} provenance-only skipped, budget 180s)…`
    );
    const t0 = Date.now();
    const probeOptions = {
      budgetMs: Number(process.env.MRT_KB_LINK_BUDGET_MS || 180000),
      concurrency: Number(process.env.MRT_LINKCHECK_CONCURRENCY || 12),
      timeoutMs: Number(process.env.MRT_LINKCHECK_TIMEOUT_MS || 8000)
    };
    // Probe ALL urls including pubmed — do NOT rely on always-live skip for the
    // audit itself. Temporarily override by calling findDeadLinks; it skips
    // always-live hosts, so force-probe pubmed/doi that look invented by also
    // checking known-dead + banned already handled.
    const dead = await findDeadLinks(citationUrls, { ...probeOptions, details: probeDetails });
    // Organisation front doors: only a definitive 404/410 counts.
    const deadResources = await findDeadLinks(resourceUrls, {
      ...probeOptions,
      blockedIsDead: false,
      details: probeDetails
    });
    for (const url of deadResources) dead.add(url);
    const blockedResources = resourceUrls.filter((url) => {
      const detail = probeDetails.get(url);
      return detail && !detail.dead && (detail.reason === 'network' || [401, 403, 451].includes(detail.status));
    });
    if (blockedResources.length) {
      info(`${blockedResources.length} organisation link(s) bounced our probe but are not gone — not failed:`);
      blockedResources.slice(0, 5).forEach((url) => {
        const detail = probeDetails.get(url);
        info(`  ${url} (${detail.reason === 'network' ? 'connection refused/reset' : `HTTP ${detail.status}`})`);
      });
    }
    deadList = [...dead].sort();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    info(`Probe finished in ${elapsed}s`);

    if (deadList.length === 0) {
      pass(`Live probe: 0 dead / ${probeUrls.length} probed KB URLs`);
    } else {
      fail(`Live probe: ${deadList.length} DEAD URL(s) across curated KBs:`);
      for (const u of deadList) {
        const where = (urlIndex.get(u) || []).map((x) => x.slug).filter((v, i, a) => a.indexOf(v) === i);
        const detail = probeDetails.get(u);
        const why = !detail ? 'known-dead host'
          : detail.reason === 'network' ? 'connection refused/reset'
            : detail.reason === 'timeout' ? 'timed out'
              : `HTTP ${detail.status}`;
        info(`DEAD ${u} (${why})`);
        info(`  ← conditions: ${where.join(', ')}`);
      }
    }

    // Per-condition dead rollup
    const deadBySlug = {};
    for (const u of deadList) {
      for (const { slug } of urlIndex.get(u) || []) {
        deadBySlug[slug] = deadBySlug[slug] || [];
        deadBySlug[slug].push(u);
      }
    }
    const cleanConditions = kbs.filter(({ slug }) => !deadBySlug[slug]?.length).length;
    if (deadList.length === 0) {
      pass(`Per-condition live probe clean (${cleanConditions}/${kbs.length})`);
    } else {
      fail(`${Object.keys(deadBySlug).length} condition(s) still pin dead URLs`);
      for (const [slug, urls] of Object.entries(deadBySlug)) {
        info(`[${slug}] ${urls.length} dead`);
      }
    }
  } else {
    info('Skipped live probe (--static). Run without --static before release.');
  }

  // Generation-side unit checks (deterministic — no network): the pipeline must
  // never *emit* banned cites from KB-derived text, and dead strip must not
  // invent PubMed searches.
  {
    const sample = kbs.find((k) => k.slug === 'ipf') || kbs[0];
    const cites = bySlug[sample.slug] || [];
    const fakeReport = cites.slice(0, 5).map((c, i) =>
      `Claim ${i + 1} about ${sample.slug} ([source ↗](${c.url})).`
    ).join('\n') + '\nAlso [Dr X](https://www.google.com/search?q=expert) and [paper](https://pubmed.ncbi.nlm.nih.gov/?term=fake).';
    const { demoteBannedClaimCitations } = await import('../lib/citation-gate.js');
    const cleaned = demoteBannedClaimCitations(fakeReport);
    const leftBanned = extractReportUrls(cleaned).filter(isBannedClaimCitation);
    if (leftBanned.length === 0 && !/google\.com\/search/i.test(cleaned)) {
      pass('Generation seal: demoteBannedClaimCitations strips Google/search cites from KB-derived prose');
    } else {
      fail(`Generation seal failed — banned left: ${leftBanned.join(' | ')}`);
    }

    const { stripDeadLinksFromText } = await import('../lib/link-check.js');
    const dud = 'https://www.sciencedirect.com/science/article/abs/pii/S0000000000000';
    const stripped = stripDeadLinksFromText(`See [label](${dud}).`, new Set([dud]), { condition: sample.slug });
    if (!stripped.includes(dud) && !/pubmed\.ncbi\.nlm\.nih\.gov\/\?term=/i.test(stripped)) {
      pass('Generation seal: dead KB-style cites demote to plain text (no PubMed-search invent)');
    } else {
      fail(`Generation seal dead-strip regression: ${stripped}`);
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    conditions: kbs.length,
    totalCitationRefs: totalCitations,
    uniqueUrls: uniqueUrls.length,
    bannedCount: banned.length,
    banned,
    deadCount: deadList.length,
    dead: deadList,
    perCondition: Object.fromEntries(
      kbs.map(({ slug }) => [slug, {
        citationCount: (bySlug[slug] || []).length,
        banned: (bySlug[slug] || []).filter((c) => isBannedClaimCitation(c.url)).map((c) => c.url),
        // dead filled only when live probe ran
        dead: deadList.filter((u) => (urlIndex.get(u) || []).some((x) => x.slug === slug))
      }])
    )
  };

  if (JSON_OUT) {
    mkdirSync(dirname(join(ROOT, JSON_OUT)), { recursive: true });
    writeFileSync(join(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
    info(`Wrote ${JSON_OUT}`);
  } else {
    mkdirSync(join(ROOT, '.verify-runs', 'link-audit'), { recursive: true });
    writeFileSync(
      join(ROOT, '.verify-runs', 'link-audit', 'all-conditions-kb.json'),
      JSON.stringify(report, null, 2)
    );
    info('Wrote .verify-runs/link-audit/all-conditions-kb.json');
  }

  console.log('');
  if (process.exitCode) {
    console.log('\x1b[31mKB link audit FAILED\x1b[0m — fix dead/banned URLs before shipping.\n');
  } else {
    console.log('\x1b[32mKB link audit passed\x1b[0m — all conditions clean.\n');
  }
};

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
