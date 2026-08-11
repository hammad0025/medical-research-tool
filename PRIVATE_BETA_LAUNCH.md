# Private-Beta Launch Gate

This document is an operating checklist, not legal advice. It is deliberately
conservative because this product handles sensitive health context and creates
medical-research summaries.

## Safe current positioning

Use this wording for the current product:

> A private, research-only beta that organizes public sources, current studies,
> and discussion questions. It does not diagnose, prescribe, or recommend
> treatment. Do not enter information that identifies a real person.

Do not say the product is HIPAA compliant, clinically validated, an electronic
medical record, a treatment recommender, a clinical decision system, or a
substitute for a clinician.

## Before invited beta access

- Confirm `SITE_ACCESS_PASSCODE`, `SITE_ACCESS_SESSION_SECRET`, and
  `SITE_ACCESS_SECURE_COOKIE=true` are set in Production and Preview.
- Configure a unique passcode and signing secret for each environment.
- Confirm the public access-status endpoint starts locked and an anonymous
  report request is rejected. Run `npm run verify:deployment` against the URL.
- Confirm the Terms and Privacy pages are reachable at `/#terms` and
  `/#privacy`.
- Confirm the support contact used in invitations can receive privacy and
  product questions.
- Run only fictional profiles in demonstrations unless a reviewed privacy and
  compliance program explicitly permits otherwise.

## Before charging for access

- Have a qualified healthcare/privacy lawyer review the intended-use wording,
  Terms, Privacy notice, and marketing claims for the target jurisdiction.
- Have a clinical reviewer test representative reports for the conditions and
  treatment categories you plan to market.
- Obtain written data-processing and security terms from every configured AI,
  hosting, analytics, and data provider. Verify any retention settings rather
  than assuming the provider discards inputs.
- Establish support, correction, source-retraction, security-incident, and
  customer-refund processes.
- If selling to a covered healthcare organization or allowing PHI, pause and
  complete a HIPAA/security program, including required vendor agreements,
  before accepting that information.
- Add payment terms, a real support address, a business entity, and applicable
  tax/refund handling before taking payment.

## Release checklist

```bash
npm run check
VERCEL=1 npm run build
DEPLOYMENT_URL=https://your-deployment.example npm run verify:deployment
```

For a full fictional report check, provide `DEPLOYMENT_TEST_PASSCODE` only in a
secure CI or deployment secret store. Never paste it into source code, a browser
field, screenshots, or chat.
