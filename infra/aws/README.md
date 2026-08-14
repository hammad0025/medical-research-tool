# AWS Transcriptomic Worker

This folder deploys a **separate source-only research worker**. It does not
replace the Vercel application and it does not create a patient, EHR, FHIR, or
report database.

## What It Runs

1. Downloads a reviewed study-level job manifest and an authorized Level 5
   GCTx source file from the encrypted input bucket.
2. Exports an A549 or other documented cell-line slice locally using `h5py`.
3. Enforces Level 5 MODZ, `by_rna_well`, `TAS >= 0.5`, explicit landmark/BING
   gene space, and complete CMap metadata.
4. Runs the existing literature novelty gate.
5. Writes an immutable, source-linked result JSON to the encrypted output
   bucket. No browser request waits for this job.

The Batch worker refuses fields that look like patient profiles, intake, EHR,
or FHIR content. It is intentionally not a HIPAA deployment or a clinical
decision-support system.

## Prerequisites

- An AWS account and credentials allowed to create the listed CloudFormation
  resources.
- Two subnets in an existing VPC. For the hardened default, use private subnets
  with a NAT gateway or appropriate VPC endpoints. For a lower-cost demo in the
  default VPC, use public subnets and pass `PUBLIC_WITH_ASSIGNED_IP` to the
  deploy script. The job needs HTTPS access to ECR, S3, PubMed, and Europe PMC.
- Docker and AWS CLI v2 on the deployment computer.
- Written authorization and terms that allow the selected CMap/LINCS GCTx file
  to be stored and processed in this AWS account. Do not put the raw source
  file in Git, ECR, a public bucket, or the browser.
- `NCBI_EMAIL` and optionally `NCBI_API_KEY` registered as AWS Batch job
  environment secrets or job-definition parameters. Never put them in the
  source manifest.

## Deploy

From the application root:

```bash
chmod +x infra/aws/deploy-transcriptomic-worker.sh
infra/aws/deploy-transcriptomic-worker.sh \
  medical-research-transcriptomic-worker \
  vpc-REPLACE \
  subnet-REPLACE-ONE,subnet-REPLACE-TWO \
  us-east-1
```

The script creates the stack once so ECR exists, builds and pushes the worker
image, then updates the stack with the immutable image tag.

For the cheaper demo path in a default public VPC, add the explicit fifth
argument:

```bash
infra/aws/deploy-transcriptomic-worker.sh \
  medical-research-transcriptomic-worker \
  vpc-REPLACE \
  subnet-PUBLIC-ONE,subnet-PUBLIC-TWO \
  us-east-1 \
  PUBLIC_WITH_ASSIGNED_IP
```

This sets the Fargate job definition `AssignPublicIp` value to `ENABLED`.
The security group still has no inbound rules, S3 public access stays blocked,
and the job role remains scoped to the encrypted input and output buckets. Do
not upload patient text, direct identifiers, EHR exports, FHIR resources, or
free-text notes.

## Run A Fictional Test Job

1. Copy `sample-transcriptomic-manifest.json` and replace every `REPLACE`
   value with a real, curator-reviewed study source and authorized GCTx source.
   The sample is a schema template, not usable research data.
2. Upload that source-only JSON and the authorized GCTx file to the private
   input bucket.
3. Submit the job:

```bash
chmod +x infra/aws/submit-transcriptomic-job.sh
infra/aws/submit-transcriptomic-job.sh \
  fictional-ipf-study-001 \
  JOB_QUEUE_ARN \
  JOB_DEFINITION_ARN \
  s3://INPUT_BUCKET/jobs/fictional-ipf-study-001.json \
  s3://OUTPUT_BUCKET/results/fictional-ipf-study-001.json
```

4. Inspect the CloudWatch log group and output artifact. A successful container
   run does not mean a candidate is valid. The release lane remains withheld
   unless the deterministic source and literature gates pass.

## Operational Rules

- Do not connect the Vercel request handler directly to Batch until there is a
  reviewed asynchronous job-status design and an artifact access policy.
- Prefer `PRIVATE_WITH_NAT` for production-like deployments. Use
  `PUBLIC_WITH_ASSIGNED_IP` only for low-cost demos where the source artifacts
  are non-patient research inputs and IAM/S3 boundaries are reviewed.
- Do not upload patient text, direct identifiers, EHR exports, FHIR resources,
  or free-text notes. The worker rejects common field names, but that is a
  safety check, not a compliance program.
- Limit who may submit jobs with a separate IAM policy scoped to this job queue
  and job definition. The CloudFormation template deliberately does not grant
  job-submission permission to arbitrary principals.
- Keep the raw GCTx input restricted. The worker's S3 job role can only read the
  input bucket and write the output bucket.
- Review AWS spend alerts, VPC egress, source-license terms, security controls,
  and scientific governance before any non-fictional use.
