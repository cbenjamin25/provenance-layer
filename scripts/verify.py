#!/usr/bin/env python3
"""
Provenance Layer — Chain Verification Walker

Reads an asset's manifest and events from S3, walks the hash chain,
and produces a VerificationRecord.

Usage:
  python scripts/verify.py <bucket> <asset_id>
  python scripts/verify.py <bucket> --key <s3_key>

Examples:
  python scripts/verify.py provenance-layer-media-cb abc123def456
  python scripts/verify.py provenance-layer-media-cb --key media/photo.jpg
"""

import sys
import json
import hashlib
import argparse
from datetime import datetime, timezone

import boto3

s3 = boto3.client("s3")
PROOF_PREFIX = "proofs/"


def read_json(bucket, key):
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read())
    except Exception:
        return None


def stable_asset_id(bucket, key):
    raw = f"{bucket}:{key}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def sha256_stream(bucket, key):
    h = hashlib.sha256()
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"]
        while True:
            chunk = body.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def verify_asset(bucket, asset_id):
    """Walk the chain and return a VerificationRecord."""
    prefix = f"{PROOF_PREFIX}assets/{asset_id}/"

    # Load manifest
    manifest = read_json(bucket, f"{prefix}manifest.json")
    if not manifest:
        return {
            "schema_version": "1.0",
            "asset_id": asset_id,
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "chain_valid": False,
            "events_checked": 0,
            "errors": [{"error": "manifest_not_found", "detail": f"No manifest at {prefix}manifest.json"}],
        }

    # Load media asset
    media_asset = read_json(bucket, f"{prefix}mediaasset.json")

    # Load and walk all events in order
    events = []
    errors = []
    expected_previous_hash = None

    for i, event_id in enumerate(manifest["events"]):
        event = read_json(bucket, f"{prefix}events/{event_id}.json")
        if not event:
            errors.append({
                "error": "event_not_found",
                "event_index": i,
                "event_id": event_id,
            })
            continue

        events.append(event)

        # --- Validate chain linkage ---

        # First event must have previous_hash = None
        if i == 0:
            if event.get("previous_hash") is not None:
                errors.append({
                    "error": "genesis_has_previous_hash",
                    "event_id": event_id,
                    "previous_hash": event["previous_hash"],
                })
        else:
            # Subsequent events must link to previous event's new_hash
            if event.get("previous_hash") != expected_previous_hash:
                errors.append({
                    "error": "chain_break",
                    "event_index": i,
                    "event_id": event_id,
                    "expected_previous_hash": expected_previous_hash,
                    "actual_previous_hash": event.get("previous_hash"),
                })

        expected_previous_hash = event.get("new_hash")

    # Verify latest hash matches manifest
    if events and events[-1].get("new_hash") != manifest.get("latest_hash"):
        errors.append({
            "error": "manifest_hash_mismatch",
            "manifest_latest_hash": manifest.get("latest_hash"),
            "last_event_new_hash": events[-1].get("new_hash") if events else None,
        })

    # Verify current file hash matches chain tip (if media asset has the key)
    live_hash = None
    if media_asset and media_asset.get("origin", {}).get("key"):
        media_key = media_asset["origin"]["key"]
        live_hash = sha256_stream(bucket, media_key)
        if live_hash and live_hash != manifest.get("latest_hash"):
            errors.append({
                "error": "live_file_tampered",
                "detail": "Current file hash does not match chain tip",
                "live_hash": live_hash,
                "chain_tip_hash": manifest.get("latest_hash"),
            })

    chain_valid = len(errors) == 0

    verification_record = {
        "schema_version": "1.0",
        "asset_id": asset_id,
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "chain_valid": chain_valid,
        "chain_status": "VERIFIED" if chain_valid else "TAMPERED",
        "events_checked": len(events),
        "latest_hash": manifest.get("latest_hash"),
        "latest_event_id": manifest.get("latest_event_id"),
        "live_file_hash": live_hash,
        "errors": errors if errors else [],
        "verifier": {
            "service": "provenance-layer-verifier",
            "version": "1.0",
        },
    }

    # Write verification record to S3
    write_key = f"{prefix}verification/latest.json"
    s3.put_object(
        Bucket=bucket,
        Key=write_key,
        Body=json.dumps(verification_record, indent=2).encode("utf-8"),
        ContentType="application/json",
    )

    return verification_record


def main():
    parser = argparse.ArgumentParser(description="Verify a Provenance Layer asset chain")
    parser.add_argument("bucket", help="S3 bucket name")
    parser.add_argument("asset_id", nargs="?", help="Asset ID (hex)")
    parser.add_argument("--key", help="S3 media key (will derive asset_id)")
    parser.add_argument("--all", action="store_true", help="Verify all assets in the bucket")
    args = parser.parse_args()

    if args.all:
        # List all asset manifests
        prefix = f"{PROOF_PREFIX}assets/"
        paginator = s3.get_paginator("list_objects_v2")
        asset_ids = set()
        for page in paginator.paginate(Bucket=args.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                parts = obj["Key"].replace(prefix, "").split("/")
                if parts:
                    asset_ids.add(parts[0])

        print(f"Found {len(asset_ids)} assets\n")
        for aid in sorted(asset_ids):
            result = verify_asset(args.bucket, aid)
            status = "✅ VERIFIED" if result["chain_valid"] else "❌ TAMPERED"
            print(f"  {aid}: {status} ({result['events_checked']} events)")
            if result["errors"]:
                for err in result["errors"]:
                    print(f"    ⚠️  {err['error']}: {err.get('detail', '')}")
        return

    if args.key:
        asset_id = stable_asset_id(args.bucket, args.key)
        print(f"Derived asset_id: {asset_id}")
    elif args.asset_id:
        asset_id = args.asset_id
    else:
        parser.error("Provide asset_id or --key")

    result = verify_asset(args.bucket, asset_id)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
