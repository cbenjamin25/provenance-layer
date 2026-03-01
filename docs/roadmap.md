# Roadmap

## v0 — MVP Skeleton ✅
- Repo + documentation
- User flow, requirements, core object definitions
- Local file hashing script

## v0.5 — Event-Driven Ingestion ✅
- S3 + Lambda pipeline (automated on upload)
- SHA-256 genesis anchor creation
- Proof artifact generation (JSON to S3)

## v1 — Chain Linkage ✅ (current)
- Cryptographic hash chain: `previous_hash → new_hash`
- Multi-event chain per asset
- Identical re-upload detection
- Verification walker with tamper detection
- Live file hash validation against chain tip
- VerificationRecord output

## v2 — Web Interface
- Upload page (drag & drop → instant provenance)
- Verification page (paste link → see chain + status)
- Shareable verification links
- API endpoints for programmatic access

## v3 — Signatures & Trust
- Digital signatures per chain event
- Actor identity verification
- Timestamping authority integration
- Canonical Proof Artifact bundler (zip with media + proofs + README)

## v4 — Integrations
- Camera/device SDK (anchor at capture)
- Platform plugins (WordPress, CMS, DAM systems)
- Court-ready export format
- Batch processing pipeline
