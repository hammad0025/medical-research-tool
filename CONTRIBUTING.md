# Contributing

This is a proprietary research prototype. External contributions are not
currently accepted, but bug reports and questions are welcome.

## Reporting issues

Email <shaque025@gmail.com> with:

- What you were trying to do
- What you expected to happen
- What actually happened
- The condition you were researching (so the issue can be reproduced)
- Browser + OS if it's a UI issue

## Local development

```bash
git clone https://github.com/hammad0025/medical-research-tool.git
cd medical-research-tool
vercel env pull .env.local
vercel dev
```

### Running tests

```bash
npm run e2e
```

The end-to-end harness invokes every serverless handler in-process and
asserts realistic behavior (IPF clinical trials are returned, PubMed
abstracts come back populated, the curated KB pins the right items, the
chat mode responds substantively, etc.).

### Adding a curated knowledge base for a new condition

1. Copy `data/kb/ipf.json` to `data/kb/<slug>.json`.
2. Replace `condition`, `slug`, `aliases`, `items`, `canonicalFacts`,
   `lifestyleRecommendations`, and `redFlags`.
3. Follow the rules in `data/kb/_schema.md`:
   - Real DOIs and URLs only (no placeholders, no guesses).
   - Honest `accessLevel` (`full-text` / `abstract` / `metadata-only`).
   - Verbatim quotes in `keyPassages` — no paraphrasing.
   - Editorial `summary` is acceptable and clearly labeled as such to the AI.
4. Run the e2e suite against the new condition to confirm it matches.

### Making prompt changes

Every change to a grounding block, system prompt, or citation rule in
`api/research.js` should be followed by an e2e run on at least one condition
to confirm citations still resolve and no format regressions slipped through.
