# Terms of Use — researchingmycondition.com

**Last updated:** July 18, 2026

By using this research tool, you agree to these Terms of Use. If you do not agree, do not use the site.

## Educational decision-support only — not medical advice

This tool summarizes published medical literature and clinical-trial registries to help you **explore** treatment options and research directions. It is **not** medical advice, a diagnosis, or a treatment recommendation. Nothing here replaces consultation with a licensed physician or other qualified healthcare provider.

## No doctor–patient relationship

Use of this site does **not** create a doctor–patient, clinician–patient, or any other professional healthcare relationship between you and the operators of this tool.

## Not HIPAA-compliant

This prototype is **not** HIPAA-compliant. Do not enter names, dates of birth, medical record numbers, addresses, phone numbers, or other personally identifying information. We do **not** store your patient profile on our servers, but the text you submit for AI analysis is sent to third-party AI providers (Anthropic and Perplexity) to generate your report (see **Data storage** below).

## No guarantee of accuracy; AI limitations

Medical literature is complex and evolving. AI-generated summaries may be incomplete, outdated, or **incorrect**, and may include references that do not exist or do not support the stated claim. We do not guarantee the accuracy, completeness, or suitability of any output.

## Your responsibility to verify

You are responsible for independently verifying every citation, link, trial listing, and factual claim before relying on it. Open source links (PubMed, ClinicalTrials.gov, DOI resolvers, etc.) and discuss findings with your care team.

## Email alerts

If you subscribe to email digests, we store your **email address, condition of interest, alert cadence, and the alert context you submit**. Alert context can include age, sex/gender, disease stage, diagnoses, medications, allergies, and short notes. This data is stored in Upstash Redis when configured (otherwise temporary process memory), is sent to **Resend** to deliver the email, and is used to personalize alerts. We retain it until you unsubscribe or the subscription expires after at most 365 days unless you create a new one; you can export or delete it with its ownership token. Do not include names, MRNs, or other direct identifying information.

## Data storage

Your browser stores the on-demand profile and up to 50 floating-chat turns in local storage so they survive a refresh. Alert email and ownership tokens are also stored locally. The site provides an **Erase local data** control that removes these application-owned browser records and resets the in-memory profile, chats, and reports.

We do **not** write the on-demand patient profile to our application database unless you separately submit some fields as alert context. The profile, chat text, condition, and gathered evidence are transmitted to **Anthropic** to generate the report. Report text, a patient snapshot, condition, and evidence may be sent to **Perplexity, OpenAI, or xAI** when configured for independent validation. Condition and drug search terms are sent to public medical-data services such as PubMed/NCBI, Europe PMC, OpenAlex, ClinicalTrials.gov, openFDA, and Unpaywall.

For abuse prevention and monthly usage limits, we store your **IP address** with a request count for up to 45 days. IP-linked plan state can be retained for up to 400 days.

We also retain a limited number of condition-level error records for up to 180 days and security-review records without direct identity fields for up to 365 days. These records are shared operational safeguards rather than a personal profile. They are not available through the end-user deletion tool because an IP address can represent multiple people and deleting selected shared security records could weaken abuse-prevention controls.

Provider retention, subprocessors, account settings, and whether a provider may use submitted data for model improvement are controlled by each provider and the operator's provider account. This repository cannot verify or guarantee those downstream practices. Review current provider terms and configured account controls before sending sensitive information.

## Age requirement

You must be **18 years or older** to use this tool, or use it only with a parent or guardian who accepts these terms on your behalf.

## Disclaimer of warranties

This tool is provided **“as is”** and **“as available”** without warranties of any kind, whether express or implied, including merchantability, fitness for a particular purpose, and non-infringement.

## Limitation of liability

To the fullest extent permitted by law, the operators of researchingmycondition.com and their contributors shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising from your use of or reliance on this tool or its outputs.

## Changes

We may update these terms. A new version requires renewed acceptance before the service can be used.

## Contact

Questions: shaque025@gmail.com
