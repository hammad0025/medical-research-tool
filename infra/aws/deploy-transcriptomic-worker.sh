#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Usage: $0 <stack-name> <vpc-id> <subnet-id-1,subnet-id-2> <aws-region> [PRIVATE_WITH_NAT|PUBLIC_WITH_ASSIGNED_IP]" >&2
  exit 2
fi

stack_name="$1"
vpc_id="$2"
subnet_ids="$3"
region="$4"
subnet_access_mode="${5:-PRIVATE_WITH_NAT}"

if [[ "$subnet_access_mode" != "PRIVATE_WITH_NAT" && "$subnet_access_mode" != "PUBLIC_WITH_ASSIGNED_IP" ]]; then
  echo "Invalid subnet access mode: $subnet_access_mode" >&2
  echo "Expected PRIVATE_WITH_NAT or PUBLIC_WITH_ASSIGNED_IP." >&2
  exit 2
fi

template_file="infra/aws/transcriptomic-worker.yaml"

aws cloudformation deploy \
  --stack-name "$stack_name" \
  --template-file "$template_file" \
  --region "$region" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "VpcId=$vpc_id" \
    "SubnetIds=$subnet_ids" \
    "SubnetAccessMode=$subnet_access_mode"

repository_uri="$(aws cloudformation describe-stacks \
  --stack-name "$stack_name" \
  --region "$region" \
  --query "Stacks[0].Outputs[?OutputKey=='WorkerRepositoryUri'].OutputValue" \
  --output text)"

account_id="$(aws sts get-caller-identity --query Account --output text)"
aws ecr get-login-password --region "$region" \
  | docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${region}.amazonaws.com"

image_tag="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
image_uri="${repository_uri}:${image_tag}"
docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.transcriptomic-worker \
  --tag "$image_uri" \
  --push \
  .

aws cloudformation deploy \
  --stack-name "$stack_name" \
  --template-file "$template_file" \
  --region "$region" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "VpcId=$vpc_id" \
    "SubnetIds=$subnet_ids" \
    "SubnetAccessMode=$subnet_access_mode" \
    "ContainerImage=$image_uri"

echo "Worker image: $image_uri"
echo "Review the stack outputs for JobQueueArn, JobDefinitionArn, InputBucketName, and OutputBucketName."
