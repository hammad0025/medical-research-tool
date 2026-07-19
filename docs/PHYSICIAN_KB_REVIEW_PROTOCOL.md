# Physician KB Review Protocol

## Purpose

This package supports independent human clinical review of the 50 automatically
generated condition knowledge bases. It does not approve any content, establish
clinical validity, or replace source review and professional judgment. The
release blocker remains active until qualified humans complete the review and
the repository's separate release controls pass.

The reviewer queue is `.verify-runs/kb-clinical-review.json`. Each entry binds a
KB file and condition to the SHA-256 digest of the exact bytes reviewed. The
review fields are intentionally blank when generated.

## Reviewer procedure

For every queue entry:

1. Confirm the file and condition are correct and independently assess whether
   your qualifications and specialty are appropriate for that condition.
2. Read the complete KB and the cited primary sources; do not rely on titles,
   abstracts, automated checks, or this queue as proof.
3. Check every approval claim for the condition, jurisdiction, population,
   indication, route, formulation, and current status. Approval for another use
   is not approval for this condition.
4. Verify every dose and quantitative efficacy statement against its cited
   source, including units, comparator, population, endpoint, and time period.
5. Review safety statements, warnings, contraindications, interactions,
   pregnancy and organ-function limits, red flags, and omitted material risks.
6. Confirm failed-trial and excluded-agent language represents efficacy failure
   for this condition and does not misclassify harm, withdrawal, discontinuation,
   or a study in another population.
7. Confirm genetic claims identify the correct gene, variant context,
   inheritance, phenotype, population, and evidence limits.
8. Resolve every evidence reference and confirm the citation supports the nearby
   statement. A working link alone is not evidence of support.

## Recording a decision

Edit only the entry's `review` object:

- `reviewer`: the reviewer's real name and professional role; never use a
  placeholder or shared identity.
- `date`: the actual completion date in `YYYY-MM-DD` format.
- `decision`: exactly `approved` or `rejected`.
- `correction`: leave blank only when no correction is required. Record required
  changes here when rejecting.

Any rejection or correction keeps verification blocked. Apply corrections to
the KB, regenerate its digest-bearing queue record, and obtain a new independent
review of the changed content. Never copy an earlier approval to a new digest.

Run `npm run kb:clinical-review:verify` after all entries are completed. It
fails for unsigned, rejected, stale, malformed, missing, duplicate, extra, or
corrected records. A passing result proves only that complete approvals are
recorded against the current files; it is not itself a medical, regulatory, or
release approval.

## Queue handling

Generate a blank queue with `npm run kb:clinical-review:generate`. Generation
refuses to overwrite populated review records. Archive review evidence under the
organization's controlled process before any intentional `--force` regeneration.
Do not edit a recorded digest manually.
