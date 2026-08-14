#!/usr/bin/env python3
"""Run a source-only transcriptomic inversion job in AWS Batch.

This worker accepts only a study-level disease expression signature and an S3
reference to an authorized LINCS GCTx file. It does not accept patient intake,
profiles, free text, or EHR/FHIR records. The final report UI reads a completed
artifact; it never calls this process from a browser request.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent
EXPORTER = ROOT / "scripts" / "exportLincsGctxSlice.py"
LINCS_IMPORTER = ROOT / "scripts" / "lincsSignatureIngestionWorker.mjs"
INVERSION_WORKER = ROOT / "scripts" / "transcriptomicInversionWorker.mjs"
INPUT_SCHEMA_VERSION = "transcriptomic-batch-input/v1"
REJECTED_ROOT_FIELDS = {"patient", "patientprofile", "profile", "intake", "ehr", "fhir", "notes", "symptoms", "medications"}
MAXIMUM_CANDIDATES = 20
MAXIMUM_SIGNATURES = 2_000


class JobInputError(ValueError):
    """The job request does not meet the no-patient-data worker contract."""


def clean_text(value, limit=500):
    return " ".join(str(value or "").split())[:limit]


def s3_location(uri):
    parsed = urlparse(clean_text(uri, 2_000))
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path.lstrip("/"):
        raise JobInputError("An S3 object URI must use the form s3://bucket/key.")
    return parsed.netloc, parsed.path.lstrip("/")


def allowed_bucket(bucket, allowed_bucket_name, label):
    if allowed_bucket_name and bucket != allowed_bucket_name:
        raise JobInputError(f"The {label} must use the configured {label} bucket.")


def required_object(value, label):
    if not isinstance(value, dict):
        raise JobInputError(f"{label} must be an object.")
    return value


def no_patient_context(value):
    if isinstance(value, list):
        for item in value:
            no_patient_context(item)
        return
    if not isinstance(value, dict):
        return
    normalized_keys = {"".join(character for character in str(key).lower() if character.isalnum()) for key in value}
    rejected = sorted(normalized_keys & REJECTED_ROOT_FIELDS)
    if rejected:
        raise JobInputError("This research worker does not accept patient, profile, intake, EHR, or FHIR fields.")
    for item in value.values():
        no_patient_context(item)


def validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise JobInputError("The input manifest must be a JSON object.")
    if clean_text(manifest.get("schemaVersion"), 120) != INPUT_SCHEMA_VERSION:
        raise JobInputError(f"The input manifest must use {INPUT_SCHEMA_VERSION}.")
    no_patient_context(manifest)

    job_id = clean_text(manifest.get("jobId"), 120)
    condition = clean_text(manifest.get("condition"), 160)
    disease_signature = required_object(manifest.get("diseaseSignature"), "diseaseSignature")
    lincs = required_object(manifest.get("lincs"), "lincs")
    required_object(lincs.get("dataset"), "lincs.dataset")
    if not job_id or not condition:
        raise JobInputError("The input manifest needs a jobId and condition.")
    if not isinstance(disease_signature.get("genes"), list) or not disease_signature["genes"]:
        raise JobInputError("The input manifest needs a curated study-level diseaseSignature.genes array.")
    gctx_uri = clean_text(lincs.get("gctxS3Uri"), 2_000)
    if not gctx_uri:
        raise JobInputError("The input manifest needs lincs.gctxS3Uri.")
    cell_lines = lincs.get("cellLines")
    if not isinstance(cell_lines, list) or not all(clean_text(cell, 120) for cell in cell_lines):
        raise JobInputError("The input manifest needs one or more documented lincs.cellLines.")
    gene_space = clean_text(lincs.get("geneSpace"), 40).lower()
    if gene_space not in {"landmark", "bing"}:
        raise JobInputError("lincs.geneSpace must be landmark or bing.")
    if clean_text(lincs.get("aggregationMethod"), 80).lower() != "by_rna_well":
        raise JobInputError("Only by_rna_well aggregated Level 5 signatures are accepted.")
    dataset = lincs["dataset"]
    if not clean_text(dataset.get("id"), 160) or not clean_text(dataset.get("title"), 320) or not clean_text(dataset.get("url"), 2_000).startswith("https://"):
        raise JobInputError("lincs.dataset needs a linked, titled source record.")
    maximum_candidates = int(manifest.get("maximumCandidates", MAXIMUM_CANDIDATES) or MAXIMUM_CANDIDATES)
    maximum_signatures = int(lincs.get("maximumSignatures", 500) or 500)
    if not 1 <= maximum_candidates <= MAXIMUM_CANDIDATES:
        raise JobInputError(f"maximumCandidates must be between 1 and {MAXIMUM_CANDIDATES}.")
    if not 1 <= maximum_signatures <= MAXIMUM_SIGNATURES:
        raise JobInputError(f"lincs.maximumSignatures must be between 1 and {MAXIMUM_SIGNATURES}.")

    return {
        "jobId": job_id,
        "condition": condition,
        "conditionSearchTerms": [clean_text(term, 160) for term in manifest.get("conditionSearchTerms", []) if clean_text(term, 160)],
        "diseaseSignature": disease_signature,
        "maximumCandidates": maximum_candidates,
        "lincs": {
            "gctxS3Uri": gctx_uri,
            "dataset": lincs["dataset"],
            "cellLines": [clean_text(cell, 120) for cell in cell_lines],
            "geneSpace": gene_space,
            "aggregationMethod": "by_rna_well",
            "minimumAbsoluteZScore": float(lincs.get("minimumAbsoluteZScore", 2) or 2),
            "minimumTas": max(float(lincs.get("minimumTas", 0.5) or 0.5), 0.5),
            "maximumSignatures": maximum_signatures,
            "restrictToCoreTouchstone": lincs.get("restrictToCoreTouchstone") is True,
        },
    }


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_command(command, environment):
    result = subprocess.run(command, cwd=ROOT, env=environment, text=True, capture_output=True, check=False)
    if result.returncode:
        message = clean_text(result.stderr or result.stdout, 1_000)
        raise RuntimeError(f"Worker command failed: {message}")
    return result.stdout


def main():
    try:
        import boto3
    except ImportError as error:
        raise SystemExit("AWS Batch worker requires boto3 in its container image.") from error

    input_uri = os.environ.get("INPUT_MANIFEST_S3_URI", "")
    output_uri = os.environ.get("OUTPUT_ARTIFACT_S3_URI", "")
    input_bucket, input_key = s3_location(input_uri)
    output_bucket, output_key = s3_location(output_uri)
    allowed_bucket(input_bucket, os.environ.get("RESEARCH_INPUT_BUCKET", ""), "input")
    allowed_bucket(output_bucket, os.environ.get("RESEARCH_OUTPUT_BUCKET", ""), "output")

    s3 = boto3.client("s3")
    with tempfile.TemporaryDirectory(prefix="transcriptomic-job-") as temporary_directory:
        work_directory = Path(temporary_directory)
        manifest_path = work_directory / "manifest.json"
        s3.download_file(input_bucket, input_key, str(manifest_path))
        manifest_bytes = manifest_path.read_bytes()
        manifest = validate_manifest(json.loads(manifest_bytes))

        gctx_bucket, gctx_key = s3_location(manifest["lincs"]["gctxS3Uri"])
        allowed_bucket(gctx_bucket, os.environ.get("RESEARCH_INPUT_BUCKET", ""), "LINCS source")
        gctx_path = work_directory / "source.gctx"
        s3.download_file(gctx_bucket, gctx_key, str(gctx_path))

        lincs = manifest["lincs"]
        dataset = lincs["dataset"]
        slice_path = work_directory / "level5-slice.json"
        perturbations_path = work_directory / "perturbations.json"
        inversion_input_path = work_directory / "inversion-input.json"
        inversion_output_path = work_directory / "inversion-output.json"
        environment = os.environ.copy()

        run_command([
            sys.executable, str(EXPORTER),
            "--gctx", str(gctx_path),
            "--dataset-id", clean_text(dataset.get("id"), 160),
            "--dataset-title", clean_text(dataset.get("title"), 320),
            "--dataset-url", clean_text(dataset.get("url"), 2_000),
            "--release", clean_text(dataset.get("release"), 120),
            "--cell-lines", ",".join(lincs["cellLines"]),
            "--gene-space", lincs["geneSpace"],
            "--aggregation-method", lincs["aggregationMethod"],
            "--minimum-absolute-z", str(lincs["minimumAbsoluteZScore"]),
            "--minimum-tas", str(lincs["minimumTas"]),
            "--maximum-signatures", str(lincs["maximumSignatures"]),
            "--output", str(slice_path),
        ], environment)

        import_command = [
            "node", str(LINCS_IMPORTER),
            "--input", str(slice_path),
            "--cell-lines", ",".join(lincs["cellLines"]),
            "--minimum-absolute-z", str(lincs["minimumAbsoluteZScore"]),
            "--minimum-tas", str(lincs["minimumTas"]),
            "--output", str(perturbations_path),
        ]
        if lincs["restrictToCoreTouchstone"]:
            import_command.append("--core-touchstone-only")
        run_command(import_command, environment)

        perturbations = json.loads(perturbations_path.read_text(encoding="utf-8"))
        inversion_input = {
            "jobId": manifest["jobId"],
            "condition": manifest["condition"],
            "conditionSearchTerms": manifest["conditionSearchTerms"],
            "diseaseSignature": manifest["diseaseSignature"],
            "perturbationSignatures": perturbations["perturbationSignatures"],
            "maximumCandidates": manifest["maximumCandidates"],
        }
        inversion_input_path.write_text(json.dumps(inversion_input, indent=2) + "\n", encoding="utf-8")
        run_command(["node", str(INVERSION_WORKER), "--input", str(inversion_input_path), "--output", str(inversion_output_path)], environment)

        inversion_result = json.loads(inversion_output_path.read_text(encoding="utf-8"))
        artifact = {
            "schemaVersion": "aws-batch-transcriptomic-result/v1",
            "jobId": manifest["jobId"],
            "completedAt": datetime.now(timezone.utc).isoformat(),
            "inputManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "lincsSource": {
                "gctxS3Uri": manifest["lincs"]["gctxS3Uri"],
                "gctxSha256": sha256_file(gctx_path),
                "dataset": perturbations["dataset"],
                "selection": perturbations["selection"],
                "importExcluded": perturbations["excluded"],
            },
            "inversion": inversion_result,
        }
        artifact_path = work_directory / "result.json"
        artifact_path.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        output_encryption_key = clean_text(os.environ.get("RESEARCH_KMS_KEY_ARN"), 2_000)
        if not output_encryption_key:
            raise RuntimeError("RESEARCH_KMS_KEY_ARN must be set by the Batch job definition.")
        s3.upload_file(str(artifact_path), output_bucket, output_key, ExtraArgs={
            "ServerSideEncryption": "aws:kms",
            "SSEKMSKeyId": output_encryption_key,
        })
        print(json.dumps({"jobId": manifest["jobId"], "output": output_uri, "released": len(inversion_result.get("released", []))}))


if __name__ == "__main__":
    try:
        main()
    except (JobInputError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(clean_text(error, 2_000), file=sys.stderr)
        raise SystemExit(1) from error
