#!/usr/bin/env python3
"""Export a documented, bounded Level 5 MODZ GCTx slice for the Node worker.

Run this only in a background environment with h5py installed and a locally
licensed or authorized CMap/LINCS GCTx file. It never runs in Vercel.
"""

import argparse
import json
from pathlib import Path

try:
    import h5py
except ImportError as error:
    raise SystemExit("This exporter needs h5py in the worker environment. Install it there with: pip install h5py") from error


def clean(value):
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    return str(value).strip()


def values_for(group, names, expected_length, required=True):
    for name in names:
        if name in group:
            values = [clean(value) for value in group[name][...]]
            if len(values) != expected_length:
                raise ValueError(f"Metadata field {name} does not match the matrix length.")
            return values
    if required:
        raise ValueError(f"The GCTx file is missing required metadata: one of {', '.join(names)}.")
    return [""] * expected_length


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def nonempty(value):
    return bool(clean(value))


def main():
    parser = argparse.ArgumentParser(description="Export an authorized Level 5 MODZ GCTx slice.")
    parser.add_argument("--gctx", required=True, help="Local .gctx file path")
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--dataset-title", required=True)
    parser.add_argument("--dataset-url", required=True, help="Public authorized dataset landing URL")
    parser.add_argument("--cell-lines", required=True, help="Comma-separated documented cell lines, for example A549")
    parser.add_argument("--output", required=True)
    parser.add_argument("--minimum-absolute-z", type=float, default=2.0)
    parser.add_argument("--minimum-tas", type=float, default=0.5)
    parser.add_argument("--maximum-signatures", type=int, default=500)
    parser.add_argument("--release", default="")
    parser.add_argument("--gene-space", required=True, choices=["landmark", "bing"],
                        help="Declared source gene space for this exported matrix slice")
    parser.add_argument("--aggregation-method", default="by_rna_well", choices=["by_rna_well"],
                        help="Documented replicate aggregation used for the Level 5 source")
    arguments = parser.parse_args()

    if not arguments.dataset_url.startswith("https://"):
        raise SystemExit("--dataset-url must be an https source link.")
    allowed_cells = {cell.strip().lower() for cell in arguments.cell_lines.split(",") if cell.strip()}
    if not allowed_cells:
        raise SystemExit("At least one documented cell line is required.")
    if arguments.minimum_absolute_z <= 0 or arguments.minimum_tas < 0.5 or arguments.maximum_signatures < 1:
        raise SystemExit("Threshold and signature limits must be positive.")

    gctx_path = Path(arguments.gctx).expanduser().resolve()
    with h5py.File(gctx_path, "r") as handle:
        required_paths = ["/0/DATA/0/matrix", "/0/META/ROW", "/0/META/COL"]
        if any(path not in handle for path in required_paths):
            raise ValueError("This file does not have the required GCTx Level 5 matrix and metadata paths.")
        matrix = handle["/0/DATA/0/matrix"]
        row_metadata = handle["/0/META/ROW"]
        column_metadata = handle["/0/META/COL"]
        if matrix.ndim != 2:
            raise ValueError("The GCTx matrix must be two-dimensional.")
        row_count, column_count = matrix.shape
        row_ids = values_for(row_metadata, ["id"], row_count)
        gene_symbols = values_for(row_metadata, ["pr_gene_symbol", "gene_symbol", "symbol"], row_count)
        signature_ids = values_for(column_metadata, ["sig_id"], column_count)
        perturbagen_ids = values_for(column_metadata, ["pert_id"], column_count)
        compound_names = values_for(column_metadata, ["pert_iname", "pert_name"], column_count)
        perturbation_types = values_for(column_metadata, ["pert_type"], column_count)
        cell_lines = values_for(column_metadata, ["cell_id", "cell_iname"], column_count)
        doses = values_for(column_metadata, ["pert_dose"], column_count)
        dose_units = values_for(column_metadata, ["pert_dose_unit"], column_count)
        dose_bins = values_for(column_metadata, ["pert_idose"], column_count)
        times = values_for(column_metadata, ["pert_time"], column_count)
        time_units = values_for(column_metadata, ["pert_time_unit"], column_count)
        time_bins = values_for(column_metadata, ["pert_itime"], column_count)
        tas_values = values_for(column_metadata, ["tas"], column_count)

        matrix_genes = [
            {"id": row_id, "symbol": symbol, "geneSpace": arguments.gene_space} if symbol else None
            for row_id, symbol in zip(row_ids, gene_symbols)
        ]
        genes = [gene for gene in matrix_genes if gene]
        if len(genes) < 8:
            raise ValueError("The GCTx row metadata does not contain enough mapped gene symbols.")
        signatures = []
        excluded = []
        for index, signature_id in enumerate(signature_ids):
            if len(signatures) >= arguments.maximum_signatures:
                break
            if perturbation_types[index].lower() != "trt_cp" or cell_lines[index].lower() not in allowed_cells:
                continue
            compound_name = compound_names[index]
            pert_id = perturbagen_ids[index]
            time_hours = number(times[index])
            tas = number(tas_values[index])
            required_values = [
                signature_id, pert_id, compound_name, doses[index], dose_units[index], dose_bins[index],
                times[index], time_units[index], time_bins[index],
            ]
            if not all(nonempty(value) for value in required_values) or time_hours is None or time_hours <= 0:
                excluded.append({"signatureId": signature_id, "pertId": pert_id, "pertName": compound_name,
                                 "reason": "Missing required CMap identity, dose, or time metadata."})
                continue
            if tas is None or tas < arguments.minimum_tas:
                excluded.append({"signatureId": signature_id, "pertId": pert_id, "pertName": compound_name,
                                 "reason": f"TAS is below the {arguments.minimum_tas} export threshold or missing."})
                continue
            vector = matrix[:, index]
            z_scores = {}
            for gene, score in zip(matrix_genes, vector):
                if gene is None:
                    continue
                score = float(score)
                if abs(score) >= arguments.minimum_absolute_z:
                    existing = z_scores.get(gene["symbol"])
                    if existing is None or abs(score) > abs(existing):
                        z_scores[gene["symbol"]] = score
            if len(z_scores) < 8:
                continue
            signatures.append({
                "signatureId": signature_id,
                "pertId": pert_id,
                "pertName": compound_name,
                "pertType": perturbation_types[index],
                "cellLine": cell_lines[index],
                "dose": doses[index],
                "doseUnit": dose_units[index],
                "doseBinned": dose_bins[index],
                "timeHours": time_hours,
                "timeUnit": time_units[index],
                "timeBinned": time_bins[index],
                "tas": tas,
                "aggregationMethod": arguments.aggregation_method,
                "zScores": z_scores,
            })

    artifact = {
        "schemaVersion": "lincs-gctx-slice/v2",
        "dataset": {
            "id": arguments.dataset_id,
            "title": arguments.dataset_title,
            "url": arguments.dataset_url,
            "level": "5",
            "processing": "MODZ moderated z-score signatures exported from a local GCTx file.",
            "aggregationMethod": arguments.aggregation_method,
            "geneSpace": arguments.gene_space,
            "release": arguments.release,
            "localArtifact": gctx_path.name,
        },
        "genes": genes,
        "signatures": signatures,
        "excluded": excluded,
        "selection": {
            "allowedCellLines": sorted(allowed_cells),
            "minimumAbsoluteZScore": arguments.minimum_absolute_z,
            "minimumTas": arguments.minimum_tas,
        },
    }
    output_path = Path(arguments.output).expanduser().resolve()
    output_path.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"exported": len(signatures), "excluded": len(excluded), "output": str(output_path)}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from error
