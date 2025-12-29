# Provenance — Q&A → Demo / Artifact Mapping

Purpose: For every hard question, show exactly where it is answered (demo moment and/or artifact).

## Tier 1 — Core Trust Questions (Must Be Answered)

### 1) What exactly does this prove?
**Answered in:**
- 5-Minute Demo → Live action (proof artifact appears)
- Proof README → “What this proves”
- Step 3 Card → “What this proves”

### 2) What does this NOT prove?
**Answered in:**
- 5-Minute Demo → Explain limits during live action
- Proof README → “What this does NOT prove”
- Step 3 Card → “What this does NOT prove”

### 3) Do I have to trust Provenance?
**Answered in:**
- 5-Minute Demo → Why this matters (“without trusting the platform”)
- Proof README → Independent verification section

### 4) How is this different from normal metadata?
**Answered in:**
- 5-Minute Demo → Context (lossy/mutable metadata problem)
- Live action → hash + proof artifact demonstration

## Tier 2 — System Integrity Questions (Very High Value)

### 5) When does Provenance start tracking a file?
**Answered in:**
- 5-Minute Demo → “the moment a file enters the system”
- AWS Proof README → ingestion boundary definition

### 6) What if the file is edited later?
**Answered in:**
- Demo → chain-of-custody framing (what we record)
- Core Objects → ChainEvent model (edits become events)

### 7) Who is the actor here — user or system?
**Answered in:**
- Core Objects → actor field (user/system)
- AWS Proof README → system actor at ingestion boundary

## Tier 3 — Attack & Skeptic Questions

### 8) Can someone fake this?
**Answered in:**
- Demo → why this matters (cryptographic verification vs trust)
- Proof README → verification steps

### 9) What about content created without Provenance?
**Answered in:**
- Demo → context framing (baseline going forward)
- Q&A → scope boundaries

### 10) Is this AI detection?
**Answered in:**
- Demo → explicit non-claim (no detection)
- Q&A → integrity/origin vs “truth” and pattern-guessing

## Added Questions (New)

### 11) What if someone steals a page/idea/screenshot and uploads it to Provenance — doesn’t that void the process?
**Answered in:**
- Demo → “what this proves / does not prove” (custody + integrity, not originality)
- Proof README / Step 3 Card → does NOT prove authorship or pre-ingestion history
- Actor model → ingestion actor ≠ creator attestation

### 12) Why do we need Provenance, and how does it differ from any other tech or platform?
**Answered in:**
- Demo → Context (why we need it)
- Demo → Live action (how it’s different: proof artifact + hash)
- Demo → Why this matters (“independently verifiable without trusting the platform”)
- Proof README → independent verification
