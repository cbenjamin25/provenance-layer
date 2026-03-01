# Core Objects

## MediaAsset
A `MediaAsset` represents a single piece of digital media anchored in the system.

It begins at **genesis** (first known bytes) and evolves through chain events. The `asset_id` is deterministic — derived from the storage path — so the same file always maps to the same asset across versions.

Fields:
- `schema_version` — data format version
- `asset_id` — stable identifier (SHA-256 of bucket:key, truncated)
- `created_at` — ISO 8601 timestamp
- `original_hash` — SHA-256 hex at genesis
- `current_hash` — SHA-256 hex of latest version
- `origin` — ingest source, bucket, key
- `content` — content type, byte size, filename
- `refs` — URIs to genesis object and proof prefix

---

## ChainEvent
A `ChainEvent` represents an immutable transformation step with cryptographic linkage to the previous state.

**Invariant:** `previous_hash` MUST equal the prior event's `new_hash`. This creates the cryptographic spine: H0 → H1 → H2 → … → Hn. Breaking any link invalidates the chain.

Fields:
- `schema_version` — data format version
- `event_id` — unique identifier (UUID)
- `asset_id` — parent asset
- `timestamp` — ISO 8601
- `event_type` — `ingest | transform | transcode | ai_transform | publish`
- `transformation` — human-readable description (e.g. "genesis_anchor", "re_upload", "resize_1080p")
- `previous_hash` — SHA-256 of prior state (null for genesis)
- `new_hash` — SHA-256 of output bytes
- `inputs` — array of `{ uri, hash }` for source files
- `outputs` — array of `{ uri, hash }` for output files
- `actor` — `{ type: human|service, id, display }`
- `tool` — `{ name, version }` of the tool that performed the action

---

## VerificationRecord
A `VerificationRecord` is the output of chain verification — a structured statement of integrity.

The verifier walks every event in order, confirms hash linkage, and checks the live file against the chain tip.

Fields:
- `schema_version` — data format version
- `asset_id` — the asset verified
- `verified_at` — ISO 8601 timestamp
- `chain_valid` — boolean
- `chain_status` — `VERIFIED` or `TAMPERED`
- `events_checked` — number of events walked
- `latest_hash` — chain tip hash
- `latest_event_id` — last event in the chain
- `live_file_hash` — current SHA-256 of the actual file
- `errors` — array of failure objects (empty if valid)
- `verifier` — `{ service, version }`

---

## Manifest
An ordered index of all chain events for an asset. Used by the verification walker to walk the chain in sequence.

Fields:
- `schema_version`
- `asset_id`
- `events` — ordered array of event IDs
- `latest_hash` — current chain tip
- `latest_event_id` — most recent event
- `updated_at` — last modification time
