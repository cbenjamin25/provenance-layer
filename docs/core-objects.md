# Core Objects

## MediaAsset
A `MediaAsset` represents a single piece of digital media that enters the system and anchors its provenance history.

Fields:
- id
- filename
- hash
- uploadTimestamp

---

## ChainEvent
A `ChainEvent` represents an immutable event in the lifecycle of a media asset. Events are append-only and ordered chronologically.

Fields:
- eventType (created, uploaded, verified, modified, exported)
- timestamp
- actor (user / system / service)

---

## VerificationRecord
A `VerificationRecord` summarizes the verification state of a media asset and is the primary artifact shared externally.

Fields:
- mediaId
- chainEvents
- verificationStatus (verified, tampered, unverified, pending)
