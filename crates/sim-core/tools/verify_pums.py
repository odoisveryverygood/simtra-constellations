#!/usr/bin/env python3
"""Verify, never overwrite, the committed PUMS snapshots against Census archives.

Python standard library only. --download retrieves official 2023 ACS 1-year
person/housing archives and records the actual UTC completion time of each fetch.
Without --download, verification is offline against recorded archive hashes.
--write publishes manifests and a minimal official person/household join under
sim-core/data (POVPIP missingness + TEN); it never changes data/*_pums.csv.
"""
import argparse
import csv
import datetime
import decimal
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[3]
BASE = "https://www2.census.gov/programs-surveys/acs/data/pums/2023/1-Year/"
DOC = "https://www2.census.gov/programs-surveys/acs/tech_docs/pums/data_dict/PUMS_Data_Dictionary_2023.txt"
CITIES = {"sf": ("ca", "06", "San Francisco"), "synth_la": ("ca", "06", "Los Angeles"),
          "neu_york": ("ny", "36", "New York City"), "cybercago": ("il", "17", "Chicago"),
          "simami": ("fl", "12", "Miami")}
LIMITATIONS = [
    "Geography is the union of the listed 2020-definition PUMAs in the specified state, not an exact city-boundary tabulation; some profiles include substantial surrounding county population.",
    "PWGTP totals are ACS survey-weighted population estimates, not exact counts or a census of every resident. Raw records are sampled observations, not synthetic residents.",
    "This is the 2023 ACS 1-year release, not current-year population data. Original repository download times are unknown; retrieved_at records this verification retrieval only.",
    "The original subset transform replaced blank numeric cells with zero. The verified context file restores POVPIP missingness and joins housing TEN by SERIALNO within the same state and release.",
    "Tenure describes the housing unit occupied by a person. Counts use person PWGTP, not household WGTP; they are not counts of homes, households, or individual property owners.",
    "Recorded PUMS SEX is not gender identity. Income-to-poverty groups use POVPIP, not dollar income or synthetic income quintiles; 501 is top-coded.",
    "Not-applicable categories remain explicit. Percentages use all person records in the selected geography, including not-applicable rows, unless a query explicitly states otherwise. These are not official poverty or unemployment rates.",
    "Replicate weights were not retained in the committed subsets; no margins of error or confidence intervals are supplied.",
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pumas(slug):
    if slug == "sf":
        return list(range(7507, 7515))
    text = (ROOT / "data/cities" / (slug + ".toml")).read_text()
    return json.loads(re.search(r"^pumas = (\[.*\])$", text, re.M).group(1))


def archive(raw_dir, kind, state, fips, download):
    name = "csv_" + kind + state + ".zip"
    path = raw_dir / name
    receipt = raw_dir / (name + ".json")
    if download:
        with urllib.request.urlopen(BASE + name, timeout=120) as response, path.open("wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        receipt.write_text(json.dumps({"url": BASE + name,
            "retrieved_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "sha256": sha(path.read_bytes())}, indent=2) + "\n")
    data = path.read_bytes()
    info = json.loads(receipt.read_text())
    require(info["url"] == BASE + name and info["sha256"] == sha(data), "archive/receipt mismatch")
    when = datetime.datetime.fromisoformat(info["retrieved_at"].replace("Z", "+00:00"))
    require(when.tzinfo is not None, "retrieval time must include timezone")
    member = "psam_" + kind + fips + ".csv"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        content = z.read(member)  # ZIP CRC checked by ZipFile on read.
    return content, {"official_download_url": BASE + name, "retrieved_at": info["retrieved_at"],
        "raw_source_sha256": sha(data), "raw_csv_member": member, "raw_csv_sha256": sha(content)}


def projected(row, columns):
    # Matches pums::load_csv + pums::write_subset, without using that implementation.
    return [row[c] if c == "SERIALNO" else
            (format(int(row[c] or 0), "05d") if c == "PUMA" else
             str(int(decimal.Decimal(row[c] or "0")))) for c in columns]


def verify_city(slug, person, housing, person_source, housing_source):
    state, fips, display = CITIES[slug]
    path = "data/" + slug + "_pums.csv"
    snapshot = (ROOT / path).read_bytes()
    reader = csv.reader(io.StringIO(snapshot.decode()))
    columns = next(reader)
    committed = list(reader)
    coverage = pumas(slug)
    selected = [{c: r[c] for c in columns} for r in csv.DictReader(io.StringIO(person.decode()))
                if int(r["PUMA"]) in coverage and int(r["PWGTP"]) > 0]
    expected = [projected(r, columns) for r in selected]
    require(expected == committed, "complete filtered person rows differ from committed snapshot")
    # Establish byte identity, including original numeric formatting and order.
    reconstructed = (",".join(columns) + "\n" + "\n".join(",".join(r) for r in expected) + "\n").encode()
    require(reconstructed == snapshot, "transformed snapshot bytes differ")
    households = {r["SERIALNO"]: {k: r[k] for k in ["PUMA", "TEN", "TYPEHUGQ"]} for r in csv.DictReader(io.StringIO(housing.decode()))
                  if int(r["PUMA"]) in coverage}
    context = io.StringIO(newline="")
    writer = csv.writer(context, lineterminator="\n")
    writer.writerow(["SERIALNO", "SPORDER", "POVPIP", "TEN", "TYPEHUGQ"])
    seen = set()
    for row in selected:
        key = (row["SERIALNO"], int(row["SPORDER"]))
        require(key not in seen, "duplicate person key")
        seen.add(key)
        h = households[row["SERIALNO"]]  # A failed join must never become invented tenure.
        require(h["PUMA"] == row["PUMA"], "person/housing PUMA mismatch")
        require(h["TEN"] in ["", "1", "2", "3", "4"], "invalid TEN")
        require(h["TYPEHUGQ"] in ["1", "2", "3"], "invalid TYPEHUGQ")
        require(bool(h["TEN"]) == (h["TYPEHUGQ"] == "1"), "occupied housing/GQ tenure mismatch")
        writer.writerow([key[0], key[1], row["POVPIP"], h["TEN"], h["TYPEHUGQ"]])
    context_bytes = context.getvalue().encode()
    context_path = "crates/sim-core/data/verified/" + slug + "_context.csv"
    manifest = {
        "city": slug, "verification_status": "Verified", "provider": "U.S. Census Bureau",
        "dataset": "ACS PUMS", "vintage": "2023", "series": "1-year",
        **person_source, "local_snapshot": path, "filtered_snapshot_sha256": sha(snapshot),
        "weight_field": "PWGTP", "raw_records": len(committed),
        "geographic_coverage": {"city_label": display, "state_fips": fips,
            "puma_definition_vintage": "2020", "pumas": coverage, "boundary_match": "not_established",
            "description": "Union of listed PUMAs; city label is a convenience, not an exact municipal boundary claim."},
        "verification_method": "Exact ordered equality of all retained fields and byte-identical reproduction of the complete official person-file PUMA subset; positive PWGTP only.",
        "transformation_command": "python3 crates/sim-core/tools/verify_pums.py --raw-dir /path/to/census-archives --download --write",
        "transformation": {"retained_columns": columns, "blank_numeric_cells": "converted to 0 in original snapshots",
            "puma_format": "five digits", "row_order": "official source order", "filter": "PUMA in geographic_coverage.pumas AND PWGTP > 0"},
        "context": {"path": context_path, "sha256": sha(context_bytes), "raw_records": len(selected),
            "columns": ["SERIALNO", "SPORDER", "POVPIP", "TEN", "TYPEHUGQ"],
            "join": "Same-state, same-release person-to-housing join on SERIALNO; confirm PUMA; one context row per committed person key.",
            "housing_source": housing_source},
        "documentation_url": DOC,
        "geography_documentation_url": "https://www.census.gov/programs-surveys/geography/guidance/geo-areas/pumas.html",
        "limitations": LIMITATIONS,
    }
    return manifest, context_bytes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    args.raw_dir.mkdir(parents=True, exist_ok=True)
    manifests = []
    for state in ["ca", "ny", "il", "fl"]:
        slugs = [s for s in CITIES if CITIES[s][0] == state]
        try:
            fips = CITIES[slugs[0]][1]
            person, ps = archive(args.raw_dir, "p", state, fips, args.download)
            housing, hs = archive(args.raw_dir, "h", state, fips, args.download)
            for slug in slugs:
                m, context = verify_city(slug, person, housing, ps, hs)
                if args.write:
                    dest = ROOT / m["context"]["path"]
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(context)
                else:
                    require((ROOT / m["context"]["path"]).read_bytes() == context,
                            "committed context differs from official source join")
                manifests.append(m)
                print(slug, "Verified", m["raw_records"], m["filtered_snapshot_sha256"], flush=True)
        except (OSError, ValueError, KeyError, AssertionError, zipfile.BadZipFile) as error:
            for slug in slugs:
                if not any(m["city"] == slug for m in manifests):
                    path = "data/" + slug + "_pums.csv"
                    manifests.append({"city": slug, "verification_status": "Unknown",
                        "provider": "U.S. Census Bureau", "dataset": "ACS PUMS", "vintage": None,
                        "series": None, "official_download_url": None, "retrieved_at": None,
                        "raw_source_sha256": None, "local_snapshot": path,
                        "filtered_snapshot_sha256": sha((ROOT / path).read_bytes()), "weight_field": "PWGTP",
                        "limitations": ["Official source verification failed: " + str(error)]})
                    print(slug, "Unknown:", error, flush=True)
    if args.write:
        dest = ROOT / "data/provenance/acs_pums.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({"schema_version": 1, "cities": manifests}, indent=2) + "\n")
    raise SystemExit(0 if all(m["verification_status"] == "Verified" for m in manifests) else 1)


if __name__ == "__main__":
    main()
