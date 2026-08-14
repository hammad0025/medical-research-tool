#!/usr/bin/env python3
"""Offline integration tests for the local GCTx exporter.

These tests only run their HDF5 assertions where h5py is installed. They create
a tiny GCTx-shaped file in a temporary directory; no CMap/LINCS data is bundled
or redistributed with this repository.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import h5py
except ImportError:
    h5py = None


ROOT = Path(__file__).resolve().parent.parent
EXPORTER = ROOT / "scripts" / "exportLincsGctxSlice.py"


def text_values(values):
    return [value.encode("utf-8") for value in values]


@unittest.skipUnless(h5py, "h5py is required for local GCTx integration tests")
class GctxExporterIntegrationTest(unittest.TestCase):
    def write_mini_gctx(self, path, include_tas=True):
        genes = ["COL1A1", "COL3A1", "TGFB1", "SMAD3", "ACTA2", "SFTPC", "SFTPA1", "AGER", "CAV1", "", "NKX2-1"]
        with h5py.File(path, "w") as handle:
            matrix = handle.create_dataset("/0/DATA/0/matrix", data=[
                [-2.5, -0.1, 2.5], [-2.6, -0.1, 2.6], [-2.7, -0.1, 2.7],
                [-2.8, -0.1, 2.8], [-2.9, -0.1, 2.9], [2.5, -0.1, -2.5],
                [2.6, -0.1, -2.6], [2.7, -0.1, -2.7], [2.8, -0.1, -2.8],
                [99.0, -0.1, 99.0], [2.9, -0.1, -2.9],
            ])
            self.assertEqual(matrix.shape, (11, 3))
            row = handle.require_group("/0/META/ROW")
            row.create_dataset("id", data=text_values([f"{index + 1}" for index in range(len(genes))]))
            row.create_dataset("pr_gene_symbol", data=text_values(genes))
            column = handle.require_group("/0/META/COL")
            metadata = {
                "sig_id": ["SIG-A549-HIGH", "SIG-A549-LOW", "SIG-PC3-HIGH"],
                "pert_id": ["BRD-A", "BRD-B", "BRD-C"],
                "pert_iname": ["test-a", "test-b", "test-c"],
                "pert_type": ["trt_cp", "trt_cp", "trt_cp"],
                "cell_id": ["A549", "A549", "PC3"],
                "pert_dose": ["10", "10", "10"],
                "pert_dose_unit": ["uM", "uM", "uM"],
                "pert_idose": ["10 uM", "10 uM", "10 uM"],
                "pert_time": ["24", "24", "24"],
                "pert_time_unit": ["h", "h", "h"],
                "pert_itime": ["24 h", "24 h", "24 h"],
            }
            if include_tas:
                metadata["tas"] = ["0.75", "0.49", "0.80"]
            for key, values in metadata.items():
                column.create_dataset(key, data=text_values(values))

    def run_export(self, gctx_path, output_path):
        return subprocess.run([
            sys.executable,
            str(EXPORTER),
            "--gctx", str(gctx_path),
            "--dataset-id", "mini-cmap-level5",
            "--dataset-title", "Mini local CMap Level 5 test",
            "--dataset-url", "https://clue.io/data",
            "--cell-lines", "A549",
            "--gene-space", "landmark",
            "--output", str(output_path),
        ], capture_output=True, text=True, check=False)

    def test_exports_only_selected_high_quality_columns_without_losing_row_alignment(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            gctx_path = temporary_path / "mini.gctx"
            output_path = temporary_path / "slice.json"
            self.write_mini_gctx(gctx_path)

            result = self.run_export(gctx_path, output_path)

            self.assertEqual(result.returncode, 0, result.stderr)
            artifact = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(artifact["schemaVersion"], "lincs-gctx-slice/v2")
            self.assertEqual(artifact["dataset"]["aggregationMethod"], "by_rna_well")
            self.assertEqual(artifact["dataset"]["geneSpace"], "landmark")
            self.assertEqual(len(artifact["signatures"]), 1)
            signature = artifact["signatures"][0]
            self.assertEqual(signature["signatureId"], "SIG-A549-HIGH")
            self.assertEqual(signature["pertId"], "BRD-A")
            self.assertEqual(signature["doseBinned"], "10 uM")
            self.assertEqual(signature["timeBinned"], "24 h")
            self.assertEqual(signature["tas"], 0.75)
            self.assertNotIn("", signature["zScores"])
            self.assertEqual(signature["zScores"]["NKX2-1"], 2.9)
            self.assertEqual(len(artifact["excluded"]), 1)
            self.assertIn("TAS", artifact["excluded"][0]["reason"])

    def test_refuses_a_gctx_file_without_tas_metadata(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            gctx_path = temporary_path / "missing-tas.gctx"
            output_path = temporary_path / "slice.json"
            self.write_mini_gctx(gctx_path, include_tas=False)

            result = self.run_export(gctx_path, output_path)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("tas", result.stderr.lower())
            self.assertFalse(output_path.exists())


if __name__ == "__main__":
    unittest.main()
