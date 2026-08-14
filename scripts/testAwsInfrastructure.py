#!/usr/bin/env python3
"""Static contract checks for the AWS Batch CloudFormation template."""

import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_PATH = ROOT / "infra" / "aws" / "transcriptomic-worker.yaml"


class CloudFormationLoader(yaml.SafeLoader):
    """Treat CloudFormation intrinsic tags as ordinary YAML nodes for testing."""


def construct_intrinsic(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


CloudFormationLoader.add_multi_constructor("!", construct_intrinsic)


class AwsInfrastructureTemplateTest(unittest.TestCase):
    def setUp(self):
        self.template = yaml.load(TEMPLATE_PATH.read_text(encoding="utf-8"), Loader=CloudFormationLoader)
        self.resources = self.template["Resources"]

    def test_declares_a_private_source_only_batch_boundary(self):
        self.assertIn("does not create a patient, EHR, or FHIR datastore", self.template["Description"])
        self.assertEqual(self.template["Parameters"]["SubnetAccessMode"]["Default"], "PRIVATE_WITH_NAT")
        self.assertEqual(
            self.template["Parameters"]["SubnetAccessMode"]["AllowedValues"],
            ["PRIVATE_WITH_NAT", "PUBLIC_WITH_ASSIGNED_IP"],
        )
        self.assertEqual(self.resources["ResearchInputBucket"]["Type"], "AWS::S3::Bucket")
        self.assertEqual(self.resources["ResearchOutputBucket"]["Type"], "AWS::S3::Bucket")
        self.assertEqual(self.resources["BatchComputeEnvironment"]["Properties"]["ComputeResources"]["Type"], "FARGATE")
        self.assertEqual(self.resources["TranscriptomicJobDefinition"]["Properties"]["PlatformCapabilities"], ["FARGATE"])
        self.assertEqual(self.resources["TranscriptomicJobDefinition"]["Properties"]["Timeout"]["AttemptDurationSeconds"], 21600)

    def test_public_subnet_mode_is_explicit_for_demo_deploys(self):
        compute_resources = self.resources["BatchComputeEnvironment"]["Properties"]["ComputeResources"]
        network_configuration = self.resources["TranscriptomicJobDefinition"]["Properties"]["ContainerProperties"]["NetworkConfiguration"]
        self.assertEqual(compute_resources["Subnets"], "SubnetIds")
        self.assertEqual(network_configuration["AssignPublicIp"], ["UsePublicSubnetMode", "ENABLED", "DISABLED"])

    def test_enforces_encryption_and_blocks_public_or_plaintext_artifacts(self):
        for bucket_name in ("ResearchInputBucket", "ResearchOutputBucket"):
            properties = self.resources[bucket_name]["Properties"]
            self.assertEqual(properties["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"]["SSEAlgorithm"], "aws:kms")
            self.assertTrue(properties["PublicAccessBlockConfiguration"]["BlockPublicPolicy"])
            self.assertTrue(properties["PublicAccessBlockConfiguration"]["RestrictPublicBuckets"])
        for policy_name in ("ResearchInputBucketPolicy", "ResearchOutputBucketPolicy"):
            statement = self.resources[policy_name]["Properties"]["PolicyDocument"]["Statement"][0]
            self.assertEqual(statement["Effect"], "Deny")
            self.assertEqual(statement["Condition"]["Bool"]["aws:SecureTransport"], False)

    def test_job_role_is_limited_to_research_artifacts(self):
        statements = self.resources["BatchJobRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        actions = {action for statement in statements for action in statement["Action"]}
        self.assertEqual(actions, {"s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "kms:Decrypt", "kms:GenerateDataKey"})
        self.assertNotIn("s3:*", actions)
        self.assertNotIn("kms:*", actions)


if __name__ == "__main__":
    unittest.main()
