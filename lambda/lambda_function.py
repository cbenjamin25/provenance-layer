"""
Provenance Layer — Ingestion Lambda

Triggered by S3 ObjectCreated events on the media/ prefix.
Creates a genesis anchor for new assets, or appends a chain event
for known assets — maintaining cryptographic hash linkage.

Proof structure in S3:
  proofs/assets/{asset_id}/mediaasset.json     — asset identity + current state
  proofs/assets/{asset_id}/events/{event_id}.json — individual chain events
  proofs/assets/{asset_id}/manifest.json        — ordered list of event IDs
"""

import os
import json
import hashlib
import uuid
from datetime import datetime, timezone
import urllib.parse

import boto3

s3 = boto3.client("s3")

SCHEMA_VERSION = "1.0"
MEDIA_PREFIX = os.environ.get("MEDIA_PREFIX", "media/")
PROOF_PREFIX = os.environ.get("PROOF_PREFIX", "proofs/")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sha256_stream(bucket: str, key: str) -> str:
    """Stream an S3 object and return its SHA-256 hex digest."""
    h = hashlib.sha256()
    body = s3.get_object(Bucket=bucket, Key=key)["Body"]
    while True:
        chunk = body.read(1024 * 1024)
        if not chunk:
            break
        h.update(chunk)
    return h.hexdigest()


def stable_asset_id(bucket: str, key: str) -> str:
    """
    Deterministic asset ID from bucket + key (without etag/version).
    Same file path always maps to the same asset, enabling chain linkage
    across re-uploads / updates.
    """
    raw = f"{bucket}:{key}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def asset_prefix(asset_id: str) -> str:
    return f"{PROOF_PREFIX}assets/{asset_id}/"


def read_json(bucket: str, key: str):
    """Read and parse a JSON object from S3. Returns None if not found."""
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read())
    except s3.exceptions.NoSuchKey:
        return None
    except Exception as e:
        if "NoSuchKey" in str(e) or "404" in str(e):
            return None
        raise


def write_json(bucket: str, key: str, data: dict):
    """Write a JSON object to S3."""
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, indent=2).encode("utf-8"),
        ContentType="application/json",
    )


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def create_genesis(bucket, key, asset_id, digest, head, now):
    """Create genesis anchor for a brand-new asset."""
    prefix = asset_prefix(asset_id)

    # -- MediaAsset record --
    media_asset = {
        "schema_version": SCHEMA_VERSION,
        "asset_id": asset_id,
        "created_at": now,
        "original_hash": digest,
        "current_hash": digest,
        "origin": {
            "ingest_source": "s3_upload",
            "bucket": bucket,
            "key": key,
        },
        "content": {
            "content_type": head.get("ContentType", "application/octet-stream"),
            "byte_size": head.get("ContentLength", 0),
            "filename": key.split("/")[-1],
        },
        "refs": {
            "genesis_object_uri": f"s3://{bucket}/{key}",
            "proof_prefix_uri": f"s3://{bucket}/{prefix}",
        },
    }

    # -- Genesis ChainEvent --
    event_id = str(uuid.uuid4())
    chain_event = {
        "schema_version": SCHEMA_VERSION,
        "event_id": event_id,
        "asset_id": asset_id,
        "timestamp": now,
        "event_type": "ingest",
        "transformation": "genesis_anchor",
        "previous_hash": None,
        "new_hash": digest,
        "inputs": [{"uri": f"s3://{bucket}/{key}", "hash": digest}],
        "outputs": [{"uri": f"s3://{bucket}/{key}", "hash": digest}],
        "actor": {"type": "service", "id": "provenance-lambda", "display": "Provenance Layer Ingestor"},
        "tool": {"name": "provenance-lambda", "version": SCHEMA_VERSION},
    }

    # -- Manifest (ordered event list) --
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "asset_id": asset_id,
        "events": [event_id],
        "latest_hash": digest,
        "latest_event_id": event_id,
        "updated_at": now,
    }

    # -- Write everything --
    write_json(bucket, f"{prefix}mediaasset.json", media_asset)
    write_json(bucket, f"{prefix}events/{event_id}.json", chain_event)
    write_json(bucket, f"{prefix}manifest.json", manifest)

    return media_asset, chain_event, manifest


def append_chain_event(bucket, key, asset_id, digest, head, now):
    """Append a new chain event to an existing asset."""
    prefix = asset_prefix(asset_id)

    # Read current state
    manifest = read_json(bucket, f"{prefix}manifest.json")
    media_asset = read_json(bucket, f"{prefix}mediaasset.json")

    if not manifest or not media_asset:
        # Shouldn't happen, but fall back to genesis
        return create_genesis(bucket, key, asset_id, digest, head, now)

    previous_hash = manifest["latest_hash"]

    # If hash unchanged, skip (identical re-upload)
    if previous_hash == digest:
        return media_asset, None, manifest

    # -- New ChainEvent --
    event_id = str(uuid.uuid4())
    chain_event = {
        "schema_version": SCHEMA_VERSION,
        "event_id": event_id,
        "asset_id": asset_id,
        "timestamp": now,
        "event_type": "transform",
        "transformation": "re_upload",
        "previous_hash": previous_hash,
        "new_hash": digest,
        "inputs": [{"uri": f"s3://{bucket}/{key}", "hash": previous_hash}],
        "outputs": [{"uri": f"s3://{bucket}/{key}", "hash": digest}],
        "actor": {"type": "service", "id": "provenance-lambda", "display": "Provenance Layer Ingestor"},
        "tool": {"name": "provenance-lambda", "version": SCHEMA_VERSION},
    }

    # -- Update manifest --
    manifest["events"].append(event_id)
    manifest["latest_hash"] = digest
    manifest["latest_event_id"] = event_id
    manifest["updated_at"] = now

    # -- Update MediaAsset --
    media_asset["current_hash"] = digest

    # -- Write --
    write_json(bucket, f"{prefix}events/{event_id}.json", chain_event)
    write_json(bucket, f"{prefix}manifest.json", manifest)
    write_json(bucket, f"{prefix}mediaasset.json", media_asset)

    return media_asset, chain_event, manifest


# ---------------------------------------------------------------------------
# Lambda handler
# ---------------------------------------------------------------------------

def handler(event, context):
    results = []

    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

        # Only process files uploaded to media/
        if not key.startswith(MEDIA_PREFIX):
            results.append({"skipped": key})
            continue

        # Get object metadata
        head = s3.head_object(Bucket=bucket, Key=key)

        # Compute SHA-256
        digest = sha256_stream(bucket, key)

        # Stable asset ID (same path = same asset)
        asset_id = stable_asset_id(bucket, key)

        now = datetime.now(timezone.utc).isoformat()

        # Check if asset already exists
        prefix = asset_prefix(asset_id)
        existing = read_json(bucket, f"{prefix}manifest.json")

        if existing is None:
            media_asset, chain_event, manifest = create_genesis(
                bucket, key, asset_id, digest, head, now
            )
            action = "genesis"
        else:
            media_asset, chain_event, manifest = append_chain_event(
                bucket, key, asset_id, digest, head, now
            )
            action = "skipped_identical" if chain_event is None else "chain_appended"

        results.append({
            "action": action,
            "asset_id": asset_id,
            "key": key,
            "hash": digest,
            "events_count": len(manifest["events"]),
        })

    return {"statusCode": 200, "results": results}
