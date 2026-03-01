# Architecture

## System Overview

```
┌─────────────┐     S3 Event      ┌──────────────────┐
│   S3 Bucket  │ ──────────────── │  Lambda Function   │
│  (media/)    │  ObjectCreated   │  (Ingestor)        │
└─────────────┘                   └────────┬───────────┘
                                           │
                              ┌────────────┼────────────┐
                              │            │            │
                              ▼            ▼            ▼
                        mediaasset.json  events/    manifest.json
                              │          {id}.json      │
                              └────────────┬────────────┘
                                           │
                                    S3 (proofs/assets/{id}/)
```

## Components

### S3 Bucket (`provenance-layer-media-cb`)
- `media/` — raw media ingestion. Upload files here.
- `proofs/assets/{asset_id}/` — proof artifacts per asset:
  - `mediaasset.json` — asset identity and current state
  - `manifest.json` — ordered list of event IDs
  - `events/{event_id}.json` — individual chain events
  - `verification/latest.json` — most recent verification result

### Lambda (`provenance-hash-on-upload`)
- **Trigger:** S3 `ObjectCreated:*` on `media/` prefix
- **Runtime:** Python 3.14
- **Timeout:** 15 seconds
- **Logic:**
  1. Receive S3 event
  2. Compute SHA-256 of uploaded file (streamed, memory-efficient)
  3. Derive stable `asset_id` from bucket + key
  4. If new asset → create genesis (mediaasset + first chain event + manifest)
  5. If existing asset → append chain event with `previous_hash → new_hash` linkage
  6. If identical re-upload → skip (no duplicate events)

### Verification Walker (`scripts/verify.py`)
- Reads manifest, walks each event in order
- Validates `previous_hash` linkage at every step
- Confirms genesis has `previous_hash: null`
- Checks chain tip matches manifest's `latest_hash`
- Checks live file hash against chain tip (detects tampering)
- Writes `VerificationRecord` to S3

## Security Model

### Cryptographic Integrity
- SHA-256 hash chain creates tamper-evident linkage
- Altering any file or event breaks the chain
- Verification is independently reproducible

### AWS IAM (Least Privilege)
- Lambda role: read from `media/*`, write to `proofs/*`
- No public access on bucket
- Bucket versioning recommended
- Object Lock (WORM) available for proofs

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| SHA-256 | Industry standard, legal/forensic grade, deterministic |
| S3 + Lambda | Event-driven, serverless, scales to any file size |
| Stable asset ID from path | Same file path = same asset across versions, enabling chain linkage |
| Proof artifacts as JSON | Machine-readable, portable, independently verifiable |
| Manifest per asset | Ordered event index for efficient chain walking |
| No DynamoDB dependency | Proofs are self-contained in S3 — no external database required |
