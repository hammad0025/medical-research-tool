# Approved public language

All reader-visible generated text crosses `lib/public-language.js` before it is
returned or rendered. Detection canonicalizes Unicode with NFKC, removes
zero-width formatting characters, and treats spacing and dash variants as
equivalent. Rewriting happens before a final prohibited-language check; any
remaining match is rejected.

Use these professional replacements consistently:

- evidence pack → sources we reviewed
- grounded evidence → published research
- disease dossier → condition overview
- K8 → quality review
- diligence packet → review materials
- demo rehearsal → presentation check
- challenge suite → safety checks
- citation audit → source check
- validation audit → independent review
- degraded coverage → partial source coverage
- internal server error → unexpected service problem
- `PROVIDER` → Treatment type
- `FDA_STATUS` → FDA status
- `REPURPOSE_SECTION` → Research category
- `EVIDENCE_STRENGTH` → Strength of research

Machine codes and provenance fields may remain in internal objects and sealed
metadata, but UI code must not display them directly. Source and journal titles
are explicitly treated as quoted source metadata so legitimate scientific
language is not rewritten. Add a positive and a negative regression fixture
when extending the map.
