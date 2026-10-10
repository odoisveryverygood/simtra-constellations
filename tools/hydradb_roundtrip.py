#!/usr/bin/env python3
"""Upload and verify the raw Sim Francisco sources in HydraDB.

The script intentionally keeps HydraDB optional: the simulator does not depend
on it, and ``--check`` verifies that the original Rust test suite still passes
after a HydraDB round trip.

Environment:
  HYDRA_DB_KEY       HydraDB API key (required)
  HYDRA_DB_TENANT_ID Tenant ID (defaults to default-tenant)
  HYDRA_DB_SUBTENANT Sub-tenant (defaults to simfrancisco-raw)

Examples:
  python3 tools/hydradb_roundtrip.py --upload
  python3 tools/hydradb_roundtrip.py --check
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "https://api.hydradb.com"
TENANT = os.environ.get("HYDRA_DB_TENANT_ID", "default-tenant")
SUBTENANT = os.environ.get("HYDRA_DB_SUBTENANT", "simfrancisco-raw")
RAW_FILES = (
    ROOT / "data/sf_pums.csv",
    ROOT / "data/news/sf.json",
    ROOT / "data/survey/atus_routine.csv",
    ROOT / "data/survey/cex_spending.csv",
    ROOT / "data/survey/hobbies.csv",
)


def tls_context() -> ssl.SSLContext:
    """Use certifi when the bundled Python lacks the macOS CA chain."""
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def api_key() -> str:
    key = os.environ.get("HYDRA_DB_KEY")
    if not key:
        raise SystemExit("HYDRA_DB_KEY is required; load it from .env before running this tool")
    return key


def request_json(path: str, payload: dict, *, query: list[tuple[str, str]] | None = None) -> dict:
    url = f"{BASE_URL}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45, context=tls_context()) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HydraDB request failed ({error.code}): {detail}") from error


def upload_file(path: Path) -> dict:
    boundary = f"----simfrancisco-{uuid.uuid4().hex}"
    body: list[bytes] = []

    def field(name: str, value: str) -> None:
        body.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode(),
                b"\r\n",
            ]
        )

    field("tenant_id", TENANT)
    field("sub_tenant_id", SUBTENANT)
    body.extend(
        [
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="files"; filename="{path.name}"\r\n'.encode(),
            b"Content-Type: application/octet-stream\r\n\r\n",
            path.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    request = urllib.request.Request(
        f"{BASE_URL}/ingestion/upload_knowledge",
        data=b"".join(body),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60, context=tls_context()) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HydraDB upload failed ({error.code}): {detail}") from error
    if not result.get("success"):
        raise SystemExit(f"HydraDB rejected {path.name}: {result}")
    return result


def boolean_recall(query: str) -> dict:
    return request_json(
        "/recall/boolean_recall",
        {
            "tenant_id": TENANT,
            "sub_tenant_id": SUBTENANT,
            "query": query,
            "operator": "phrase",
            "search_mode": "knowledge",
        },
    )


def fetch_original(source_id: str) -> bytes:
    result = request_json(
        "/fetch/content",
        {
            "tenant_id": TENANT,
            "source_id": source_id,
            "sub_tenant_id": SUBTENANT,
            "mode": "content",
        },
    )
    if result.get("content") is not None:
        return result["content"].encode("utf-8")
    if result.get("content_base64"):
        return base64.b64decode(result["content_base64"])
    raise AssertionError(f"HydraDB did not return original content for source {source_id}")


def check_pums() -> None:
    with (ROOT / "data/sf_pums.csv").open(newline="") as handle:
        header, row = next(csv.reader(handle)), next(csv.reader(handle))
    query = row[0]
    result = boolean_recall(query)
    chunks = [chunk.get("chunk_content", "") for chunk in result.get("chunks", [])]
    # HydraDB's parsed table display drops the fixed-width zero in PUMA, while
    # its original-content endpoint preserves the uploaded bytes exactly.
    display_row = row.copy()
    display_row[16] = str(int(display_row[16]))
    normalized = "| " + " | ".join(display_row) + " |"
    normalized_chunks = [" ".join(chunk.replace("|", " | ").split()) for chunk in chunks]
    if not any(normalized in chunk for chunk in normalized_chunks):
        raise AssertionError(f"HydraDB did not return the expected raw PUMS row {query}")
    source_ids = [source.get("id") for source in result.get("sources", []) if source.get("id")]
    if not source_ids:
        raise AssertionError("HydraDB did not identify the PUMS source for original-content verification")
    local_bytes = (ROOT / "data/sf_pums.csv").read_bytes()
    hydra_bytes = fetch_original(source_ids[0])
    local_hash = hashlib.sha256(local_bytes).hexdigest()
    hydra_hash = hashlib.sha256(hydra_bytes).hexdigest()
    if local_hash != hydra_hash:
        raise AssertionError(f"Raw PUMS hash mismatch: local={local_hash} hydra={hydra_hash}")
    print(f"PUMS parsed recall: PASS ({query}; {len(header)} fields)")
    print(f"PUMS original-content hash: PASS ({local_hash})")


def check_news() -> None:
    news = json.loads((ROOT / "data/news/sf.json").read_text())
    headline = news["articles"][0]["headline"]
    result = boolean_recall(headline)
    chunks = [chunk.get("chunk_content", "") for chunk in result.get("chunks", [])]
    if not any(headline in chunk for chunk in chunks):
        raise AssertionError(f"HydraDB did not return the expected news headline: {headline}")
    print("News round trip: PASS")


def check_simulator() -> None:
    subprocess.run(["cargo", "test", "-p", "simfrancisco", "--lib"], cwd=ROOT, check=True)
    print("Simulator regression suite: PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upload", action="store_true", help="upload the five scoped raw sources")
    parser.add_argument("--check", action="store_true", help="run HydraDB round trips and cargo tests")
    args = parser.parse_args()
    if not args.upload and not args.check:
        parser.error("choose --upload and/or --check")

    if args.upload:
        for path in RAW_FILES:
            result = upload_file(path)
            source = result.get("results", [{}])[0]
            print(f"Uploaded {path.relative_to(ROOT)}: {source.get('status', 'unknown')}")
    if args.check:
        check_pums()
        check_news()
        check_simulator()
    return 0


if __name__ == "__main__":
    sys.exit(main())
