import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadProductionReportParsers } from '../scripts/test-helpers/production-report-parsers.mjs';

const source = [
  await readFile(new URL('../index.html', import.meta.url), 'utf8'),
  await readFile(new URL('../src/app.jsx', import.meta.url), 'utf8')
].join('\n');
let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`\x1b[32m✓\x1b[0m ${name}`);
};

test('approved treatment parser retains efficacy dosing safety and interactions', () => {
  const { parseTreatments } = loadProductionReportParsers();
  const [card] = parseTreatments(`PROVIDER: Antifibrotic medicine
TREATMENT: Example drug
FDA_STATUS: Approved
LENGTH_FREQUENCY: 100 mg twice daily with food.
EFFICACY: Reduced annual decline in the measured study outcome.
SAFETY: MODERATE — monitoring is required.
RISKS: Nausea and liver enzyme elevation.
INTERACTIONS: Review anticoagulants and strong enzyme inhibitors.
REFERENCES: [Study](https://pubmed.ncbi.nlm.nih.gov/12345678/)`);
  assert.equal(card.length_frequency, '100 mg twice daily with food.');
  assert.match(card.efficacy, /Reduced annual decline/);
  assert.equal(card.safety_band, 'Moderate');
  assert.match(card.interactions, /anticoagulants/);
});

test('approved treatment parser never substitutes a manufacturer for a missing treatment', () => {
  const { parseTreatments } = loadProductionReportParsers();
  const cards = parseTreatments(`PROVIDER: Abbott / AbbVie
FDA_STATUS: approved
EFFICACY: Benefit described in the reviewed label. [FDA label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc)
REFERENCES: [FDA label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc)`);
  assert.equal(cards.length, 0);
});

test('unknown safety status is parsed without duplicating the visible label', () => {
  const { parseTreatments } = loadProductionReportParsers();
  const [card] = parseTreatments(`PROVIDER: Teva
TREATMENT: Rasagiline
FDA_STATUS: approved
SAFETY: Safety concern: Unknown — exact product label did not match.
REFERENCES: [FDA label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc)`);
  assert.equal(card.safety_band, 'Unknown');
  assert.equal(card.safety_note, 'exact product label did not match.');
});

test('approved treatment parser does not require a provider line', () => {
  const { parseTreatments } = loadProductionReportParsers();
  const [card] = parseTreatments(`TREATMENT: Rasagiline
FDA_STATUS: approved
REFERENCES: [FDA label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=abc)`);
  assert.equal(card.treatment, 'Rasagiline');
});

test('approved treatment screen and full export render all retained fields', () => {
  for (const label of [
    'Dose and schedule', 'What studies found', 'Safety',
    'Risks', 'Medication interactions'
  ]) {
    assert.match(source, new RegExp(`>${label}:?\\s*<|['"]${label}['"]`));
  }
  assert.match(source, /if \(t\.length_frequency\) body \+= field\('Dose and schedule'/);
  assert.match(source, /if \(t\.efficacy\) body \+= field\('What studies found'/);
  assert.match(source, /if \(t\.interactions\) body \+= field\('Medication interactions'/);
});

test('frontend has no blocking native alert or prompt controls', () => {
  assert.doesNotMatch(source, /\b(?:alert|prompt)\s*\(/);
  assert.match(source, /mrt:user-feedback/);
  assert.match(source, /aria-live=/);
});

test('fake account controls and browser-stored identity are absent from live UI', () => {
  assert.doesNotMatch(source, /setSignInOpen|<SignInModal|localStorage\.(?:getItem|setItem)\(['"]mrt_user/);
  assert.doesNotMatch(source, />\s*Sign in\s*</i);
});

test('access passcode remains session-only', () => {
  assert.match(source, /\/api\/access-session/);
  assert.doesNotMatch(source, /mrt_access_passcode_v1|localStorage\.setItem\([^)]*passcode/i);
});

test('unsubscribe uses an inline labelled form instead of a prompt', () => {
  assert.match(source, /id="mrt-unsubscribe-code"/);
  assert.match(source, /Confirm unsubscribe/);
  assert.match(source, /readOwnerTokens\(email\)\.find/);
});

test('tabs dialogs forms tables and motion expose accessibility behavior', () => {
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /aria-selected=\{active\}/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /useDialogAccessibility/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /className="mrt-table-scroll"/);
  assert.match(source, /htmlFor=\{`mrt-profile-\$\{f\.k\}`\}/);
});

test('profile changes invalidate all prior and in-flight run state', () => {
  for (const reset of [
    "setResearchText('')", "setRepurposeText('')", "setTrialsText('')",
    'setTrialsData(null)', 'setEvidenceSummary(null)', 'setProgress(null)'
  ]) assert.match(source, new RegExp(reset.replace(/[()]/g, '\\$&')));
  assert.match(source, /currentProfileKeyRef\.current !== runProfileKey/);
  assert.match(source, /outdated result was discarded/);
});

test('full export uses the report citation allowlist', () => {
  assert.match(source, /const allowedUrls = buildAllowedUrlSet\(trialsData, evidenceSummary/);
  assert.match(source, /renderMarkdownForExport\(value, allowedUrls\)/);
  assert.match(source, /references\.filter\(\(r\) => urlIsAllowed\(r\.url, allowedUrls\)\)/);
});

test('trimmed synthesis pools preserve the signed trial-registry payload', () => {
  assert.match(source, /registrySeal:\s*trials\.registrySeal/);
});

console.log(`\n${passed} Phase 4 frontend checks passed.`);
