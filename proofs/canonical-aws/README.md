# Canonical AWS Proof Example (Provenance)

This is the canonical AWS mirror of the local proof example.

It demonstrates that the moment a file enters the S3 ingestion boundary, the system generates a proof artifact that can be verified independently.

## AWS boundary and system actor (from our AWS + S3 + Lambda setup)
- Ingestion boundary: S3 prefix `media/`
- Proof artifact namespace: S3 prefix `proofs/`
- Trigger: `s3:ObjectCreated:*` filtered to `media/`
- System actor: Lambda `provenance-hash-on-upload` (role: `provenance-lambda-role`)
- Record store: DynamoDB table `ProofRecordsV2`

## Canonical bucket + paths
Bucket:
- `provenance-layer-media-cb`

Canonical AWS MediaAsset:
- `s3://provenance-layer-media-cb/media/canonical-aws/canonical-media-v2.txt`

Canonical AWS proof artifact (system-generated):
- `s3://provenance-layer-media-cb/proofs/media/canonical-aws/canonical-media-v2.txt.sha256.json`

## How to reproduce (upload)
Create a local file:
```bash
mkdir -p /tmp/provenance-canonical-aws
printf "%s\n" \
"PROVENANCE — CANONICAL AWS PROOF EXAMPLE (V2)" \
"This object demonstrates a genesis anchor at ingestion and a generated proof artifact." \
> /tmp/provenance-canonical-aws/canonical-media-v2.txt

