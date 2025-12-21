import os
import json
import hashlib
from datetime import datetime, timezone
import urllib.parse

import boto3

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")

TABLE_NAME = os.environ.get("TABLE_NAME")
MEDIA_PREFIX = os.environ.get("MEDIA_PREFIX", "media/")
PROOF_PREFIX = os.environ.get("PROOF_PREFIX", "proofs/")

def sha256_stream(bucket: str, key: str) -> str:
    """
    Stream the S3 object and compute SHA-256 without loading the whole file into memory.
    """
    h = hashlib.sha256()
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"]

    while True:
        chunk = body.read(1024 * 1024)  # 1MB chunks
        if not chunk:
            break
        h.update(chunk)

    return h.hexdigest()

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
        size_bytes = head.get("ContentLength")
        etag = head.get("ETag", "").replace('"', "")

        # Generate hash
        digest = sha256_stream(bucket, key)

        # Deterministic media ID for MVP (bucket + key + etag)
        media_id = f"{bucket}:{key}:{etag}"

        now = datetime.now(timezone.utc).isoformat()

        proof = {
            "mediaAsset": {
                "id": media_id,
                "bucket": bucket,
                "key": key,
                "filename": key.split("/")[-1],
                "sizeBytes": size_bytes,
                "uploadedAt": now,
                "hash": {"algo": "sha256", "value": digest},
            },
            "chainEvents": [
                {
                    "eventType": "hash_generated",
                    "timestamp": now,
                    "actor": "system",
                    "details": {"trigger": "s3:ObjectCreated", "etag": etag},
                }
            ],
        }

        # Write proof JSON to S3 under proofs/
        proof_key = f"{PROOF_PREFIX}{key}.sha256.json"
        s3.put_object(
            Bucket=bucket,
            Key=proof_key,
            Body=json.dumps(proof, indent=2).encode("utf-8"),
            ContentType="application/json",
        )

        # Write index record to DynamoDB (optional but recommended)
        if TABLE_NAME:
            ddb.put_item(
                TableName=TABLE_NAME,
                Item={
                    "mediaId": {"S": media_id},
                    "bucket": {"S": bucket},
                    "key": {"S": key},
                    "proofS3Key": {"S": proof_key},
                    "hashAlgo": {"S": "sha256"},
                    "hashValue": {"S": digest},
                    "createdAt": {"S": now},
                    "proofJson": {"S": json.dumps(proof)},
                },
            )

        results.append({"processed": key, "proofKey": proof_key, "mediaId": media_id})

    return {"statusCode": 200, "results": results}

