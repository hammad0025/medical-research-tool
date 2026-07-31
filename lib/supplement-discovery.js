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

// The KB's own pipeline list is curated and often names the best-evidenced OTC
// options for a condition (vitamin A palmitate and NAC for RP, for example).
// Deriving lane C purely from whatever the live gather happened to retrieve
// meant those were routinely absent from the ideas list even though our own
// curated data named them.
const curatedSupplementSeeds = (evidence) => {
  const drugs = Array.isArray(evidence?.pipelineDrugs) ? evidence.pipelineDrugs : [];
  return drugs
    .filter((drug) => {
      const blob = [drug?.name, ...(drug?.aliases || []), drug?.mechanism, drug?.approvalStatus]
        .filter(Boolean).join(' ');
      return SUPPLEMENT_RE.test(blob);
    })
    .map((drug) => {
      const url = drug.pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${drug.pmid}/`
        : (drug.doi ? `https://doi.org/${drug.doi}` : '');
      return {
        name: drug.name,
        status: drug.status || drug.approvalStatus || '',
        why: drug.whyItMatters || drug.mechanism || '',
        url
      };
    })
    .slice(0, 8);
};

const curatedSeedBlock = (seeds) => {
  if (!seeds.length) return '';
  const lines = seeds.map((s) => {
    const bits = [s.status, s.why].filter(Boolean).join(' ');
    return `- ${s.name}${s.url ? ` — ${s.url}` : ''}${bits ? `\n  ${bits}` : ''}`;
  });
  return `
=== CURATED OTC / SUPPLEMENT OPTIONS FOR THIS CONDITION (from the knowledge base) ===
These are curated, condition-specific OTC/dietary options. Output a CANDIDATE for each one that is genuinely OTC or dietary, using the name a patient would say, and cite the link shown. If a curated safety caveat exists (for example a genotype that must be excluded first), state it in the card rather than dropping the candidate.

${lines.join('\n')}

=== END CURATED OTC / SUPPLEMENT OPTIONS ===
`;
};

export const buildSupplementDiscoveryBlock = (evidence) => {
  const curated = curatedSeedBlock(curatedSupplementSeeds(evidence));
  const items = (evidence?.groundedForPrompt || evidence?.topRanked || [])
    .filter(isSupplementEvidenceItem)
    .slice(0, 14);
  if (!items.length) {
    if (curated) {
      return `${curated}
=== OTC / SUPPLEMENT LITERATURE IN THIS PACK ===
No additional supplement-specific papers were retrieved in this gather pass. Use the curated options above; do not pad with generic vitamins.
=== END ===`;
    }
    return `=== OTC / SUPPLEMENT LITERATURE IN THIS PACK ===
No supplement-specific papers were retrieved in this gather pass. Lane C may still propose OTC ideas ONLY if you find supplement mentions elsewhere in this evidence pack — otherwise skip padding with generic vitamins.
=== END ===`;
  }
  const lines = items.map((it, i) => {
    const yr = it.year ? ` (${it.year})` : '';
    const url = it.url || it.pubmedUrl || it.doiUrl || '';
    return `- [#${i + 1}] ${it.title}${yr}${url ? ` — ${url}` : ''}`;
  });
  return `${curated}=== OTC / SUPPLEMENT LITERATURE IN THIS PACK (Lane C — derive candidates FROM THESE, plain-English names) ===
The gather step pulled these supplement/dietary/OTC papers live from PubMed/EPMC/KB. For EACH relevant paper, output a CANDIDATE using the name a patient would say (e.g. "Goji berries", "TUDCA", "Taurine", "Alpha-lipoic acid") — NOT Latin binomials alone. Cite the paper link in REFERENCES.

${lines.join('\n')}

=== END OTC / SUPPLEMENT LITERATURE ===`;
};
