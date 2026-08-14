#!/usr/bin/env python3
"""Static contract checks for the AWS Batch CloudFormation template."""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_PATH = ROOT / "infra" / "aws" / "transcriptomic-worker.yaml"


def indented_block(text, parent_name, indent=2):
    """Return a CloudFormation block without requiring PyYAML on Vercel."""
    pattern = rf"(?ms)^{re.escape(' ' * indent + parent_name)}:\n(.*?)(?=^{' ' * indent}\w|\Z)"
    match = re.search(pattern, text)
    if not match:
        raise AssertionError(f"Could not find block for {parent_name}.")
    return match.group(0)


class AwsInfrastructureTemplateTest(unittest.TestCase):
    def setUp(self):
        self.template_text = TEMPLATE_PATH.read_text(encoding="utf-8")
        self.parameters = indented_block(self.template_text, "Parameters", indent=0)
        self.resources = indented_block(self.template_text, "Resources", indent=0)

    def parameter_block(self, name):
        return indented_block(self.parameters, name)

    def resource_block(self, name):
        return indented_block(self.resources, name)

    def test_declares_a_private_source_only_batch_boundary(self):
        self.assertIn("does not create a patient, EHR, or FHIR datastore", self.template_text)
        subnet_mode = self.parameter_block("SubnetAccessMode")
        self.assertIn("Default: PRIVATE_WITH_NAT", subnet_mode)
        self.assertIn("AllowedValues: [PRIVATE_WITH_NAT, PUBLIC_WITH_ASSIGNED_IP]", subnet_mode)
        self.assertIn("Type: AWS::S3::Bucket", self.resource_block("ResearchInputBucket"))
        self.assertIn("Type: AWS::S3::Bucket", self.resource_block("ResearchOutputBucket"))
        self.assertIn("Type: FARGATE", self.resource_block("BatchComputeEnvironment"))
        job_definition = self.resource_block("TranscriptomicJobDefinition")
        self.assertIn("PlatformCapabilities: [FARGATE]", job_definition)
        self.assertIn("AttemptDurationSeconds: 21600", job_definition)

    def test_public_subnet_mode_is_explicit_for_demo_deploys(self):
        compute_environment = self.resource_block("BatchComputeEnvironment")
        job_definition = self.resource_block("TranscriptomicJobDefinition")
        self.assertIn("Subnets: !Ref SubnetIds", compute_environment)
        self.assertIn("AssignPublicIp: !If [UsePublicSubnetMode, ENABLED, DISABLED]", job_definition)

    def test_enforces_encryption_and_blocks_public_or_plaintext_artifacts(self):
        for bucket_name in ("ResearchInputBucket", "ResearchOutputBucket"):
            bucket = self.resource_block(bucket_name)
            self.assertIn("SSEAlgorithm: aws:kms", bucket)
            self.assertIn("BlockPublicPolicy: true", bucket)
            self.assertIn("RestrictPublicBuckets: true", bucket)
        for policy_name in ("ResearchInputBucketPolicy", "ResearchOutputBucketPolicy"):
            policy = self.resource_block(policy_name)
            self.assertIn("Effect: Deny", policy)
            self.assertIn("aws:SecureTransport: false", policy)

    def test_job_role_is_limited_to_research_artifacts(self):
        role = self.resource_block("BatchJobRole")
        for action in ("s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "kms:Decrypt", "kms:GenerateDataKey"):
            self.assertIn(action, role)
        self.assertNotIn("s3:*", role)
        self.assertNotIn("kms:*", role)


if __name__ == "__main__":
    unittest.main()
