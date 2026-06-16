// Derive OTC / supplement hints from the LIVE evidence pack — not hardcoded KB seeds.
// Lane C should cite what gather actually pulled from PubMed/EPMC/KB.

const SUPPLEMENT_RE =
  /\b(goji|wolfberry|lycium|tudca|tauroursodeoxycholic|taurine|lipoic|lutein|\bdha\b|fish oil|omega-3|nac|n-acetylcysteine|vitamin [a-e]|supplement|dietary|otc|over-the-counter|antioxidant|herbal|carotenoid|bile acid)\b/i;

export const isSupplementEvidenceItem = (item) => {
  const blob = [
    item?.title,
    item?.text,
    item?.abstract,
    item?.summary,
    item?.kbCategory
  ].filter(Boolean).join(' ');
  return SUPPLEMENT_RE.test(blob);
};

export const buildSupplementDiscoveryBlock = (evidence) => {
  const items = (evidence?.groundedForPrompt || evidence?.topRanked || [])
    .filter(isSupplementEvidenceItem)
    .slice(0, 14);
  if (!items.length) {
    return `=== OTC / SUPPLEMENT LITERATURE IN THIS PACK ===
No supplement-specific papers were retrieved in this gather pass. Lane C may still propose OTC ideas ONLY if you find supplement mentions elsewhere in this evidence pack — otherwise skip padding with generic vitamins.
=== END ===`;
  }
  const lines = items.map((it, i) => {
    const yr = it.year ? ` (${it.year})` : '';
    const url = it.url || it.pubmedUrl || it.doiUrl || '';
    return `- [#${i + 1}] ${it.title}${yr}${url ? ` — ${url}` : ''}`;
  });
  return `=== OTC / SUPPLEMENT LITERATURE IN THIS PACK (Lane C — derive candidates FROM THESE, plain-English names) ===
The gather step pulled these supplement/dietary/OTC papers live from PubMed/EPMC/KB. For EACH relevant paper, output a CANDIDATE using the name a patient would say (e.g. "Goji berries", "TUDCA", "Taurine", "Alpha-lipoic acid") — NOT Latin binomials alone. Cite the paper link in REFERENCES.

${lines.join('\n')}

=== END OTC / SUPPLEMENT LITERATURE ===`;
};
