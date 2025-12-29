# Provenance Layer — 5-Minute Demo (Canonical)

> Rules: Present tense only. No future features. No AI detection talk.

## Context (≈30 seconds)
Digital media can no longer be trusted by default.

The cost of creating and altering realistic digital content has collapsed.
As media moves across platforms, copies lose context, metadata changes, and origin becomes unverifiable.

This creates legal, market, and reputational risk — not because people disagree about truth, but because provenance is missing

## The exact problem (≈30 seconds)
Before we can argue about truth, intent, or meaning, we need to establish origin.

Most digital content today has no verifiable genesis anchor.
Platforms act as implicit authorities.
Metadata is mutable.
Files circulate without a documented chain of custody.

There is no neutral way to answer:

Who introduced this content into circulation?
When did that happen?
What verifiable changes occurred afterward?

## What This System Is  (≈1 minute)
This system is the Provenance Layer.

The Provenance Layer is a neutral authenticity infrastructure that records where digital content comes from, how it changes, and how confident we should be in it — without deciding what’s true.

When a file enters the system, a genesis anchor is created.
This is a cryptographic fingerprint representing the file’s exact state at the moment of entry.

That genesis anchor becomes the root of a verification record.

From that point forward, verified interactions with the file are recorded as chain events, forming a tamper-evident chain of custody.

The system records verifiable facts about origin and transformation — not interpretation.

## Live action (≈2 minutes)
Media enters the Provenance Layer through an explicit upload or integration point, where provenance recording begins.

I upload a media asset.

At upload, the system generates a cryptographic hash of the file.
This hash uniquely identifies this exact version of the media asset.

A verification record is created.

The verification record contains:

A media asset identifier

The genesis anchor hash

A timestamp

An initial chain event marking entry into the system

A proof artifact appears.

This proof artifact is machine-readable and independently verifiable.
It does not rely on trust in this platform, the uploader, or any intermediary.

If the file is copied without change, the hash remains the same.
If the file is altered in any way, the hash changes.

When the hash changes, the system can prove that the media asset is no longer identical to its genesis anchor.

The chain of custody either remains intact — or it does not.

## Why this matters (≈1 minute)
The Provenance Layer makes authenticity assessable without relying on authority.

Content owners can demonstrate when media entered circulation.
Journalists can evaluate whether content has a documented origin and intact chain of custody.
Courts can assess digital evidence using verification records rather than assumption.
Third parties can independently verify integrity using proof artifacts.

The system does not decide what is real.
It provides verifiable context so others can decide how much confidence to place in the content.

That is the missing layer of the digital world.
