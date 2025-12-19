# MVP Requirements (v0)

Must-have:
- Upload a file (image/video)
- Compute cryptographic hash
- Extract basic metadata (file type, size; EXIF when present)
- Show “Integrity Record” page with hash + metadata
- Generate a shareable verification link

Nice-to-have:
- Detect common edit indicators (metadata changes, re-encoding signatures)
- “Edit count” summary (best-effort)
- Model-assisted analysis to surface potential indicators of modification (non-deterministic, informational only)
