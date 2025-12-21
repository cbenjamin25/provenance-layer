# Day 4 — Event-Driven Provenance Anchor (S3 + Lambda)

## What was built
An automated provenance ingestion pipeline where media uploads to S3
automatically generate a cryptographic provenance anchor.

Uploads placed under the `media/` prefix trigger an AWS Lambda function that:
- streams the uploaded object
- computes a SHA-256 cryptographic hash
- generates a structured provenance record
- writes an immutable proof artifact to `proofs/`
- indexes the proof in DynamoDB for lookup

This establishes the **genesis provenance record** for any asset entering the system.

---

## Architecture
S3 (`media/`)  
→ S3 ObjectCreated Event  
→ Lambda (hash + proof generation)  
→ S3 (`proofs/`) + DynamoDB (`ProofRecords`)

---

## Key Design Decisions

### Why S3
- Canonical, durable storage for original media
- Native event triggers
- Scales to large files (video, images, documents)

### Why Lambda
- Event-driven (no manual execution)
- Stateless, deterministic execution
- System-generated provenance (no user trust required)

### Why SHA-256
- Industry-standard cryptographic hash
- Deterministic and independently verifiable
- Suitable for legal, journalistic, and studio workflows

### Why `media/` → `proofs/` mirroring
Proof artifacts mirror the original object path:
- `media/test.rtf`
- `proofs/media/test.rtf.sha256.json`

This preserves a direct, auditable relationship between source media and its proof.

---

## Output Artifact (Provenance Anchor Record)

Each upload produces a JSON record containing:
- Canonical asset identity (bucket, key, size)
- Cryptographic integrity anchor (SHA-256)
- Timestamped provenance event
- System actor attribution
- Trigger source (S3 ObjectCreated)

This record can be shared and independently verified without trusting the platform.

---

## Result
Any asset entering Provenance now receives an immutable,
system-generated provenance anchor that can be verified at any time.
