# Transcriptomic Inversion Worker

This is a separate research worker. It is not part of the Vercel request that
creates a patient-facing report. A queue worker or scheduled container should
run it, store the JSON artifact, and only send completed artifacts to the app.

## What it does

1. Takes a curated, human disease expression signature from GEO, Expression
   Atlas, or another linked source.
2. Takes measured CMap/LINCS perturbation signatures for named compounds.
3. Scores shared genes using negative cosine similarity. A positive score means
   the compound moved shared genes in the opposite direction in that experiment.
4. Requires a PubMed and Europe PMC search for each condition name before it
   labels a candidate `Not researched for this condition`.

It does not train a neural network, generate a molecule, predict a clinical
benefit, estimate a dose, or decide what a person should take.

## Required job shape

```json
{
  "jobId": "ipf-gse-curated-2026-08-12",
  "condition": "Idiopathic Pulmonary Fibrosis",
  "conditionSearchTerms": ["Pulmonary Fibrosis"],
  "diseaseSignature": {
    "condition": "Idiopathic Pulmonary Fibrosis",
    "source": {
      "id": "geo-gse12345",
      "title": "Exact study title",
      "url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE12345",
      "accession": "GSE12345",
      "organism": "Homo sapiens",
      "tissue": "Lung",
      "contrast": "IPF lung versus control lung",
      "processing": "Curator and method used to create the table"
    },
    "genes": [{ "symbol": "COL1A1", "log2FoldChange": 1.8, "adjustedPValue": 0.01 }]
  },
  "perturbationSignatures": [{
    "compoundName": "Exact compound name",
    "source": {
      "id": "cmap-sig-id",
      "title": "CMap L1000 signature for Exact compound name",
      "url": "https://clue.io/",
      "signatureId": "exact signature ID",
      "pertId": "exact perturbagen ID",
      "pertName": "Exact compound name",
      "cellLine": "A549",
      "dose": "10",
      "doseUnit": "uM",
      "doseBinned": "10 uM",
      "timeHours": 24,
      "timeUnit": "h",
      "timeBinned": "24 h",
      "tas": 0.72,
      "aggregationMethod": "by_rna_well",
      "geneSpace": "landmark",
      "dataset": "L1000",
      "processing": "Level 5 signature"
    },
    "genes": [{ "symbol": "COL1A1", "zScore": -1.2 }]
  }]
}
```

The sample is intentionally incomplete. A production job needs at least eight
filtered disease genes and eight genes shared with each perturbation signature.

## Run it

```bash
NCBI_EMAIL=research@example.org \
node scripts/transcriptomicInversionWorker.mjs \
  --input /secure/jobs/ipf.json \
  --output /secure/results/ipf.json
```

## Create a GEO signature job

First search GEO for studies to review. This creates a study list, not a disease
signature:

```bash
NCBI_EMAIL=research@example.org \
node scripts/geoSignatureIngestionWorker.mjs \
  --find \
  --condition "Idiopathic Pulmonary Fibrosis" \
  --output /secure/review/ipf-geo-studies.json
```

After a researcher verifies a human cohort, tissue, case/control contrast, and
the differential-expression method, pass its curated TSV or CSV table to the
importer. The table must contain a gene-symbol column, a log fold-change column,
and an adjusted p-value column. The default filters are `abs(logFC) >= 1.5` and
`adjusted p <= 0.05`.

```bash
NCBI_EMAIL=research@example.org \
node scripts/geoSignatureIngestionWorker.mjs \
  --condition "Idiopathic Pulmonary Fibrosis" \
  --condition-search-terms "Pulmonary Fibrosis" \
  --gse GSE12345 \
  --dge /secure/curated/ipf-gse12345-dge.tsv \
  --tissue "Lung" \
  --contrast "IPF lung versus control lung" \
  --output /secure/jobs/ipf-gse12345.json
```

This checks that the GEO metadata is human, saves the source and sample
manifest, and fails when the DGE table lacks either direction of change. It does
not infer case/control labels, map unverified probe IDs, or compute statistics
from a raw series matrix. Those are study-specific bioinformatics decisions and
need documented human review before the worker can use them.

## Create a local LINCS perturbation artifact

The local LINCS path has two steps. In a compute worker with `h5py`, export a
bounded slice from an authorized, locally stored `.gctx` file. The exporter
accepts only Level 5 MODZ data aggregated by `by_rna_well`. Each exported
signature must have a CMap `sig_id`, `pert_id`, compound name, `cell_id`, raw
and canonical (`pert_idose` / `pert_itime`) dose and time, and `TAS >= 0.5`.
The job must explicitly declare whether the input is the `landmark` or `BING`
gene space; it will not infer this from an incomplete matrix.

```bash
python3 scripts/exportLincsGctxSlice.py \
  --gctx /secure/lincs/level5-modz.gctx \
  --dataset-id cmap-level5-release \
  --dataset-title "Authorized CMap L1000 Level 5 release" \
  --dataset-url "https://clue.io/data" \
  --cell-lines A549 \
  --gene-space landmark \
  --output /secure/slices/a549-level5.json
```

Then validate that slice into the Node perturbation contract:

```bash
node scripts/lincsSignatureIngestionWorker.mjs \
  --input /secure/slices/a549-level5.json \
  --cell-lines A549 \
  --minimum-tas 0.5 \
  --output /secure/jobs/a549-perturbations.json
```

The importer only keeps values where `abs(z score) >= 2` by default. It rejects
Level 3 or 4 data, non-small-molecule perturbations, missing metadata, records
with `TAS < 0.5`, gene-space mismatches, signatures outside the chosen cell
line, and duplicate compound signatures. A duplicate is withheld rather than
silently choosing a more favorable result. Add `--core-touchstone-only` only
when a job should limit the selected cell lines to the nine core Touchstone
lines; that restriction is optional, not a claim that other cell lines are
invalid. Before ranking, merge the resulting
`perturbationSignatures` into a GEO job artifact.

Run the exporter integration test in a worker image that has `h5py` installed:

```bash
python3 scripts/testLincsGctxExporter.py
```

It generates a small temporary HDF5 file with the standard
`/0/DATA/0/matrix`, `/0/META/ROW`, and `/0/META/COL` layout. The test verifies
column selection, row alignment, TAS filtering, and failure when required
metadata is absent. It does not include or download a real CMap/LINCS file.

The worker writes a versioned JSON artifact containing source records, score
settings, overlapping genes, every literature query, released candidates, and
withheld candidates. Store the input and output artifacts with their checksum
and software commit. Do not store a patient profile in either artifact.

## Deployment boundary

Use a queue with durable storage, retry policy, encrypted secrets, and an audit
log. The Vercel app should request a completed artifact by job ID; it should
never download raw GEO matrices or full L1000 files in a browser request.

Official data-access references: [NCBI GEO programmatic access](https://www.ncbi.nlm.nih.gov/geo/info/geo_paccess.html), [CMap developer resources](https://clue.io/developer-resources), [Europe PMC REST API](https://europepmc.org/RestfulWebService), and [PubMed E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/).
