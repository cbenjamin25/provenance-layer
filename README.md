# Provenance Layer

**Cryptographic authenticity infrastructure for digital media.**

Provenance Layer records where digital media comes from, how it changes, and who performed each action — establishing a tamper-evident chain of custody from capture through every transformation.

> Provenance is to media what HTTPS is to web traffic — a baseline expectation.

## How It Works

```
Upload file → Genesis anchor (SHA-256) → Chain events track every change → Verify anytime
```

1. **Genesis Anchor** — When media enters the system, a cryptographic fingerprint (SHA-256) is computed and recorded as the immutable origin point.

2. **Chain of Custody** — Every subsequent change creates a new chain event, cryptographically linked to the previous state via `previous_hash → new_hash`.

3. **Verification** — Walk the hash chain to prove integrity. If any file or event is altered, the chain breaks — tampering is detected instantly.

4. **Proof Artifact** — A portable, machine-readable bundle that can be independently verified by studios, journalists, courts, or regulators without trusting the platform.

## Architecture

```
S3 (media/)
  → S3 ObjectCreated event
  → Lambda (hash + chain linkage)
  → S3 (proofs/assets/{id}/)
       ├── mediaasset.json        # Asset identity + current state
       ├── manifest.json           # Ordered event chain
       ├── events/{id}.json        # Individual chain events
       └── verification/latest.json # Verification record
```

- **Ingestion is event-driven** — upload a file, provenance is recorded automatically
- **Chain linkage is cryptographic** — H0 → H1 → H2 → … → Hn. Break any link, verification fails.
- **Identical re-uploads are detected** and skipped (no duplicate events)

## Data Model

### MediaAsset
The logical identity of a file across time. Begins at genesis, evolves through chain events.

| Field | Description |
|-------|-------------|
| `asset_id` | Stable identifier (deterministic from storage path) |
| `original_hash` | SHA-256 at genesis |
| `current_hash` | SHA-256 of latest version |
| `origin` | Source attribution (device, service, user) |
| `content` | File metadata (type, size, dimensions) |

### ChainEvent
An immutable transformation step with cryptographic linkage.

| Field | Description |
|-------|-------------|
| `event_type` | `ingest`, `transform`, `transcode`, `ai_transform`, `publish` |
| `previous_hash` | Must equal prior event's `new_hash` (null for genesis) |
| `new_hash` | SHA-256 of output bytes |
| `actor` | Who performed the action (human or service) |
| `tool` | What tool was used |
| `timestamp` | When it happened |

### VerificationRecord
The output of chain verification — proves integrity or detects tampering.

| Field | Description |
|-------|-------------|
| `chain_valid` | `true` if all links verify |
| `chain_status` | `VERIFIED` or `TAMPERED` |
| `events_checked` | Number of events walked |
| `live_file_hash` | Current file hash vs chain tip |
| `errors` | What broke (if tampered) |

## Quick Start

### Verify an asset
```bash
python scripts/verify.py provenance-layer-media-cb --key media/photo.jpg
```

### Verify all assets
```bash
python scripts/verify.py provenance-layer-media-cb --all
```

### Local test (no AWS needed)
```bash
python scripts/test_chain.py
```

### Hash a file locally
```bash
node scripts/hash-file.js path/to/file
```

## What This Solves

| Scenario | Without Provenance | With Provenance Layer |
|----------|-------------------|----------------------|
| Deepfake circulates | No way to verify origin | Genesis anchor proves when original entered the system |
| Image edited and re-shared | No record of changes | Chain of custody shows every transformation |
| Court needs digital evidence | Metadata is mutable, easily challenged | Cryptographic proof artifact is independently verifiable |
| Studio distributes content | No chain of custody after delivery | Every handoff is a recorded chain event |

## Project Status

- ✅ Event-driven ingestion pipeline (S3 + Lambda)
- ✅ Cryptographic hash chain with `previous_hash → new_hash` linkage
- ✅ Genesis anchor creation
- ✅ Chain event appending on file updates
- ✅ Identical re-upload detection
- ✅ Verification walker with tamper detection
- ✅ Live file hash validation against chain tip
- 🔜 Web interface (upload + verify)
- 🔜 Digital signatures per event
- 🔜 Canonical Proof Artifact bundler
- 🔜 API endpoints

## License

All rights reserved. © Cedric Benjamin
