#!/usr/bin/env python3
"""Contract tests for the no-patient-data AWS Batch manifest."""

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "awsTranscriptomicBatchWorker.py"
SPEC = importlib.util.spec_from_file_location("aws_transcriptomic_worker", MODULE_PATH)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


def sample_manifest():
    return {
        "schemaVersion": "transcriptomic-batch-input/v1",
        "jobId": "fictional-study-job",
        "condition": "Example condition",
        "diseaseSignature": {
            "condition": "Example condition",
            "source": {"id": "GSETEST", "title": "Example source", "url": "https://example.org"},
            "genes": [{"symbol": "GENE1", "log2FoldChange": 2, "adjustedPValue": 0.01}],
        },
        "lincs": {
            "gctxS3Uri": "s3://research-input/authorized/source.gctx",
            "dataset": {"id": "cmap-test", "title": "Authorized test dataset", "url": "https://example.org/dataset"},
            "cellLines": ["A549"],
            "geneSpace": "landmark",
            "aggregationMethod": "by_rna_well",
        },
    }


class AwsTranscriptomicManifestTest(unittest.TestCase):
    def test_accepts_only_a_source_level_job_manifest(self):
        manifest = WORKER.validate_manifest(sample_manifest())
        self.assertEqual(manifest["jobId"], "fictional-study-job")
        self.assertEqual(manifest["maximumCandidates"], 20)
        self.assertEqual(manifest["lincs"]["minimumTas"], 0.5)

    def test_rejects_patient_and_ehr_fields_even_when_nested(self):
        manifest = sample_manifest()
        manifest["diseaseSignature"]["profile"] = {"patient": {"name": "Not allowed"}}
        with self.assertRaisesRegex(WORKER.JobInputError, "does not accept patient"):
            WORKER.validate_manifest(manifest)

    def test_rejects_an_unlinked_dataset_and_unbounded_job_size(self):
        unlinked = sample_manifest()
        unlinked["lincs"]["dataset"]["url"] = "http://example.org"
        with self.assertRaisesRegex(WORKER.JobInputError, "linked"):
            WORKER.validate_manifest(unlinked)

        oversized = sample_manifest()
        oversized["lincs"]["maximumSignatures"] = 2001
        with self.assertRaisesRegex(WORKER.JobInputError, "maximumSignatures"):
            WORKER.validate_manifest(oversized)


if __name__ == "__main__":
    unittest.main()
