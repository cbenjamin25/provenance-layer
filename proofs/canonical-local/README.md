# Canonical Local Proof Example (Provenance)

This folder contains one canonical MediaAsset and its canonical proof artifact.

## What this proves
- The MediaAsset has a stable genesis anchor (SHA-256).
- The proof artifact records that genesis anchor as a tamper-evident integrity reference.
- Anyone can independently verify the MediaAsset matches the proof artifact.

## Files
- `original/canonical-media.txt` — MediaAsset
- `record/provenance-proof.json` — Proof artifact (VerificationRecord)

## Verify (macOS / Linux)
1) Compute SHA-256 of the MediaAsset:
```bash
shasum -a 256 original/canonical-media.txt

