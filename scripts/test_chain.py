#!/usr/bin/env python3
"""
Local integration test — simulates uploads and verifies chain linkage
without touching S3. Writes proof artifacts to local filesystem.

Usage:
  python scripts/test_chain.py
"""

import os
import sys
import json
import hashlib
import uuid
import tempfile
import shutil
from datetime import datetime, timezone

SCHEMA_VERSION = "1.0"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable_asset_id(bucket: str, key: str) -> str:
    raw = f"{bucket}:{key}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def read_json(path):
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def simulate_upload(proof_dir, bucket, key, content: bytes):
    """Simulate what the Lambda does for one upload."""
    digest = sha256_bytes(content)
    asset_id = stable_asset_id(bucket, key)
    prefix = os.path.join(proof_dir, "assets", asset_id)
    now = datetime.now(timezone.utc).isoformat()

    manifest_path = os.path.join(prefix, "manifest.json")
    asset_path = os.path.join(prefix, "mediaasset.json")
    manifest = read_json(manifest_path)

    if manifest is None:
        # Genesis
        event_id = str(uuid.uuid4())
        media_asset = {
            "schema_version": SCHEMA_VERSION,
            "asset_id": asset_id,
            "created_at": now,
            "original_hash": digest,
            "current_hash": digest,
            "origin": {"ingest_source": "test", "bucket": bucket, "key": key},
            "content": {"byte_size": len(content), "filename": key.split("/")[-1]},
        }
        chain_event = {
            "schema_version": SCHEMA_VERSION,
            "event_id": event_id,
            "asset_id": asset_id,
            "timestamp": now,
            "event_type": "ingest",
            "transformation": "genesis_anchor",
            "previous_hash": None,
            "new_hash": digest,
            "actor": {"type": "service", "id": "test"},
        }
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "asset_id": asset_id,
            "events": [event_id],
            "latest_hash": digest,
            "latest_event_id": event_id,
            "updated_at": now,
        }
        action = "genesis"
    else:
        previous_hash = manifest["latest_hash"]
        if previous_hash == digest:
            print(f"  ⏭️  Identical re-upload, skipped")
            return asset_id, "skipped"

        event_id = str(uuid.uuid4())
        media_asset = read_json(asset_path)
        media_asset["current_hash"] = digest

        chain_event = {
            "schema_version": SCHEMA_VERSION,
            "event_id": event_id,
            "asset_id": asset_id,
            "timestamp": now,
            "event_type": "transform",
            "transformation": "re_upload",
            "previous_hash": previous_hash,
            "new_hash": digest,
            "actor": {"type": "service", "id": "test"},
        }
        manifest["events"].append(event_id)
        manifest["latest_hash"] = digest
        manifest["latest_event_id"] = event_id
        manifest["updated_at"] = now
        action = "chain_appended"

    write_json(asset_path, media_asset)
    write_json(os.path.join(prefix, "events", f"{event_id}.json"), chain_event)
    write_json(manifest_path, manifest)

    return asset_id, action


def verify_local(proof_dir, asset_id):
    """Walk the chain locally and verify integrity."""
    prefix = os.path.join(proof_dir, "assets", asset_id)
    manifest = read_json(os.path.join(prefix, "manifest.json"))

    if not manifest:
        return False, ["manifest_not_found"]

    errors = []
    expected_previous = None

    for i, event_id in enumerate(manifest["events"]):
        event = read_json(os.path.join(prefix, "events", f"{event_id}.json"))
        if not event:
            errors.append(f"event_not_found: {event_id}")
            continue

        if i == 0:
            if event.get("previous_hash") is not None:
                errors.append(f"genesis_has_previous_hash: {event['previous_hash']}")
        else:
            if event.get("previous_hash") != expected_previous:
                errors.append(
                    f"chain_break at event {i}: expected {expected_previous}, got {event.get('previous_hash')}"
                )

        expected_previous = event.get("new_hash")

    if expected_previous != manifest.get("latest_hash"):
        errors.append(f"manifest_hash_mismatch: chain tip {expected_previous} != manifest {manifest.get('latest_hash')}")

    return len(errors) == 0, errors


def main():
    proof_dir = tempfile.mkdtemp(prefix="provenance_test_")
    bucket = "test-bucket"
    key = "media/photo.jpg"

    print("=" * 60)
    print("Provenance Layer — Chain Linkage Test")
    print("=" * 60)

    # --- Test 1: Genesis ---
    print("\n📸 Upload v1 (genesis)...")
    v1_content = b"original photo bytes version 1"
    asset_id, action = simulate_upload(proof_dir, bucket, key, v1_content)
    print(f"  Asset ID: {asset_id}")
    print(f"  Action:   {action}")
    print(f"  Hash:     {sha256_bytes(v1_content)}")

    # --- Test 2: Modified re-upload ---
    print("\n✏️  Upload v2 (modified)...")
    v2_content = b"edited photo bytes version 2 with crop applied"
    asset_id, action = simulate_upload(proof_dir, bucket, key, v2_content)
    print(f"  Action:   {action}")
    print(f"  Hash:     {sha256_bytes(v2_content)}")

    # --- Test 3: Another modification ---
    print("\n🎨 Upload v3 (color graded)...")
    v3_content = b"color graded photo bytes version 3"
    asset_id, action = simulate_upload(proof_dir, bucket, key, v3_content)
    print(f"  Action:   {action}")
    print(f"  Hash:     {sha256_bytes(v3_content)}")

    # --- Test 4: Identical re-upload ---
    print("\n♻️  Re-upload v3 (identical)...")
    asset_id, action = simulate_upload(proof_dir, bucket, key, v3_content)

    # --- Verify chain ---
    print("\n🔍 Verifying chain...")
    valid, errors = verify_local(proof_dir, asset_id)
    manifest = read_json(os.path.join(proof_dir, "assets", asset_id, "manifest.json"))
    print(f"  Events:  {len(manifest['events'])}")
    print(f"  Valid:   {'✅ VERIFIED' if valid else '❌ TAMPERED'}")
    if errors:
        for e in errors:
            print(f"  ⚠️  {e}")

    # --- Print the chain ---
    print("\n📋 Full chain:")
    for i, eid in enumerate(manifest["events"]):
        event = read_json(os.path.join(proof_dir, "assets", asset_id, "events", f"{eid}.json"))
        prev = event.get("previous_hash", "None")
        new = event.get("new_hash")
        arrow = "GENESIS" if prev is None else f"{prev[:12]}… → {new[:12]}…"
        print(f"  [{i}] {event['event_type']:12} | {arrow}")

    # --- Tamper test ---
    print("\n🔓 Tampering with event 1 (changing previous_hash)...")
    event_1_id = manifest["events"][1]
    event_1_path = os.path.join(proof_dir, "assets", asset_id, "events", f"{event_1_id}.json")
    event_1 = read_json(event_1_path)
    event_1["previous_hash"] = "0000000000000000000000000000000000000000000000000000000000000000"
    write_json(event_1_path, event_1)

    valid, errors = verify_local(proof_dir, asset_id)
    print(f"  Valid:   {'✅ VERIFIED' if valid else '❌ TAMPERED (correctly detected)'}")
    if errors:
        for e in errors:
            print(f"  ⚠️  {e}")

    # Cleanup
    shutil.rmtree(proof_dir)
    print(f"\n{'=' * 60}")
    print("All tests passed ✅" if not valid else "Something went wrong")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
