#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 <job-name> <job-queue-arn> <job-definition-arn> <input-manifest-s3-uri> <output-artifact-s3-uri>" >&2
  exit 2
fi

job_name="$1"
job_queue="$2"
job_definition="$3"
input_uri="$4"
output_uri="$5"

case "$input_uri" in s3://*) ;; *) echo "Input must be an s3:// URI." >&2; exit 2 ;; esac
case "$output_uri" in s3://*) ;; *) echo "Output must be an s3:// URI." >&2; exit 2 ;; esac

aws batch submit-job \
  --job-name "$job_name" \
  --job-queue "$job_queue" \
  --job-definition "$job_definition" \
  --container-overrides "environment=[{name=INPUT_MANIFEST_S3_URI,value=$input_uri},{name=OUTPUT_ARTIFACT_S3_URI,value=$output_uri}]"
