/**
 * Provenance Layer — REST API
 *
 * Endpoints:
 *   POST   /api/upload              Upload file → genesis or chain append
 *   GET    /api/assets              List all assets
 *   GET    /api/assets/:id          Get asset details + full chain
 *   GET    /api/assets/:id/verify   Verify chain integrity
 *   GET    /api/verify?hash=<hex>   Look up asset by hash
 *   GET    /api/health              Health check
 */

import express from "express";
import multer from "multer";
import cors from "cors";
import crypto from "crypto";
import { Readable } from "stream";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BUCKET = process.env.BUCKET || "provenance-layer-media-cb";
const REGION = process.env.AWS_REGION || "us-east-1";
const MEDIA_PREFIX = "media/";
const PROOF_PREFIX = "proofs/";
const PORT = process.env.PORT || 3000;
const SCHEMA_VERSION = "1.0";

const s3 = new S3Client({ region: REGION });

// ---------------------------------------------------------------------------
// S3 Helpers
// ---------------------------------------------------------------------------
async function readJSON(key) {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await resp.Body.transformToString();
    return JSON.parse(body);
  } catch (e) {
    if (e.name === "NoSuchKey" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404 || e.name === "AccessDenied") {
      return null;
    }
    throw e;
  }
}

async function writeJSON(key, data) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json",
  }));
}

async function putFile(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || "application/octet-stream",
  }));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stableAssetId(bucket, key) {
  return crypto.createHash("sha256").update(`${bucket}:${key}`).digest("hex").slice(0, 16);
}

function assetPrefix(assetId) {
  return `${PROOF_PREFIX}assets/${assetId}/`;
}

// ---------------------------------------------------------------------------
// Core Logic
// ---------------------------------------------------------------------------
async function createGenesis(bucket, key, digest, fileSize, contentType) {
  const assetId = stableAssetId(bucket, key);
  const prefix = assetPrefix(assetId);
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();

  const mediaAsset = {
    schema_version: SCHEMA_VERSION,
    asset_id: assetId,
    created_at: now,
    original_hash: digest,
    current_hash: digest,
    origin: { ingest_source: "api_upload", bucket, key },
    content: {
      content_type: contentType,
      byte_size: fileSize,
      filename: key.split("/").pop(),
    },
    refs: {
      genesis_object_uri: `s3://${bucket}/${key}`,
      proof_prefix_uri: `s3://${bucket}/${prefix}`,
    },
  };

  const chainEvent = {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    asset_id: assetId,
    timestamp: now,
    event_type: "ingest",
    transformation: "genesis_anchor",
    previous_hash: null,
    new_hash: digest,
    inputs: [{ uri: `s3://${bucket}/${key}`, hash: digest }],
    outputs: [{ uri: `s3://${bucket}/${key}`, hash: digest }],
    actor: { type: "service", id: "provenance-api", display: "Provenance Layer API" },
    tool: { name: "provenance-api", version: SCHEMA_VERSION },
  };

  const manifest = {
    schema_version: SCHEMA_VERSION,
    asset_id: assetId,
    events: [eventId],
    latest_hash: digest,
    latest_event_id: eventId,
    updated_at: now,
  };

  await Promise.all([
    writeJSON(`${prefix}mediaasset.json`, mediaAsset),
    writeJSON(`${prefix}events/${eventId}.json`, chainEvent),
    writeJSON(`${prefix}manifest.json`, manifest),
  ]);

  return { mediaAsset, chainEvent, manifest, action: "genesis" };
}

async function appendChainEvent(bucket, key, assetId, digest, fileSize, contentType) {
  const prefix = assetPrefix(assetId);
  const [manifest, mediaAsset] = await Promise.all([
    readJSON(`${prefix}manifest.json`),
    readJSON(`${prefix}mediaasset.json`),
  ]);

  if (!manifest || !mediaAsset) {
    return createGenesis(bucket, key, digest, fileSize, contentType);
  }

  // Skip identical
  if (manifest.latest_hash === digest) {
    return { mediaAsset, chainEvent: null, manifest, action: "skipped_identical" };
  }

  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const previousHash = manifest.latest_hash;

  const chainEvent = {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    asset_id: assetId,
    timestamp: now,
    event_type: "transform",
    transformation: "re_upload",
    previous_hash: previousHash,
    new_hash: digest,
    inputs: [{ uri: `s3://${bucket}/${key}`, hash: previousHash }],
    outputs: [{ uri: `s3://${bucket}/${key}`, hash: digest }],
    actor: { type: "service", id: "provenance-api", display: "Provenance Layer API" },
    tool: { name: "provenance-api", version: SCHEMA_VERSION },
  };

  manifest.events.push(eventId);
  manifest.latest_hash = digest;
  manifest.latest_event_id = eventId;
  manifest.updated_at = now;
  mediaAsset.current_hash = digest;

  await Promise.all([
    writeJSON(`${prefix}events/${eventId}.json`, chainEvent),
    writeJSON(`${prefix}manifest.json`, manifest),
    writeJSON(`${prefix}mediaasset.json`, mediaAsset),
  ]);

  return { mediaAsset, chainEvent, manifest, action: "chain_appended" };
}

async function verifyAsset(assetId) {
  const prefix = assetPrefix(assetId);
  const manifest = await readJSON(`${prefix}manifest.json`);

  if (!manifest) {
    return {
      schema_version: SCHEMA_VERSION,
      asset_id: assetId,
      verified_at: new Date().toISOString(),
      chain_valid: false,
      chain_status: "NOT_FOUND",
      events_checked: 0,
      errors: [{ error: "manifest_not_found" }],
    };
  }

  const mediaAsset = await readJSON(`${prefix}mediaasset.json`);
  const errors = [];
  const events = [];
  let expectedPrev = null;

  for (let i = 0; i < manifest.events.length; i++) {
    const eventId = manifest.events[i];
    const event = await readJSON(`${prefix}events/${eventId}.json`);

    if (!event) {
      errors.push({ error: "event_not_found", event_index: i, event_id: eventId });
      continue;
    }

    events.push(event);

    if (i === 0 && event.previous_hash !== null) {
      errors.push({ error: "genesis_has_previous_hash", event_id: eventId });
    } else if (i > 0 && event.previous_hash !== expectedPrev) {
      errors.push({
        error: "chain_break",
        event_index: i,
        event_id: eventId,
        expected: expectedPrev,
        actual: event.previous_hash,
      });
    }

    expectedPrev = event.new_hash;
  }

  if (events.length && events[events.length - 1].new_hash !== manifest.latest_hash) {
    errors.push({
      error: "manifest_hash_mismatch",
      manifest_latest: manifest.latest_hash,
      chain_tip: events[events.length - 1]?.new_hash,
    });
  }

  // Check live file
  let liveHash = null;
  if (mediaAsset?.origin?.key) {
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: mediaAsset.origin.key }));
      const chunks = [];
      for await (const chunk of resp.Body) chunks.push(chunk);
      liveHash = sha256(Buffer.concat(chunks));
      if (liveHash !== manifest.latest_hash) {
        errors.push({
          error: "live_file_tampered",
          live_hash: liveHash,
          chain_tip: manifest.latest_hash,
        });
      }
    } catch (e) {
      // File might have been deleted
    }
  }

  const record = {
    schema_version: SCHEMA_VERSION,
    asset_id: assetId,
    verified_at: new Date().toISOString(),
    chain_valid: errors.length === 0,
    chain_status: errors.length === 0 ? "VERIFIED" : "TAMPERED",
    events_checked: events.length,
    latest_hash: manifest.latest_hash,
    latest_event_id: manifest.latest_event_id,
    live_file_hash: liveHash,
    errors,
    verifier: { service: "provenance-api", version: SCHEMA_VERSION },
  };

  // Write verification record
  await writeJSON(`${prefix}verification/latest.json`, record).catch(() => {});

  return { ...record, events, mediaAsset };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "provenance-layer-api", version: SCHEMA_VERSION });
});

// Upload file
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const filename = req.file.originalname || "upload";
    const key = `${MEDIA_PREFIX}uploads/${Date.now()}-${filename}`;
    const digest = sha256(req.file.buffer);
    const assetId = stableAssetId(BUCKET, key);

    // Upload to S3
    await putFile(key, req.file.buffer, req.file.mimetype);

    // Check if asset exists
    const existing = await readJSON(`${assetPrefix(assetId)}manifest.json`);
    let result;

    if (!existing) {
      result = await createGenesis(BUCKET, key, digest, req.file.size, req.file.mimetype);
    } else {
      result = await appendChainEvent(BUCKET, key, assetId, digest, req.file.size, req.file.mimetype);
    }

    res.json({
      asset_id: assetId,
      action: result.action,
      hash: digest,
      key,
      events_count: result.manifest.events.length,
      verify_url: `/api/assets/${assetId}/verify`,
    });
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ error: "Upload failed", detail: e.message });
  }
});

// Upload by hash (client-side hashing — just register provenance without uploading file)
app.post("/api/anchor", async (req, res) => {
  try {
    const { hash, filename, size, content_type } = req.body;
    if (!hash || hash.length !== 64) {
      return res.status(400).json({ error: "Invalid SHA-256 hash (64 hex chars required)" });
    }

    const key = `${MEDIA_PREFIX}anchored/${hash.slice(0, 8)}/${filename || "unknown"}`;
    const assetId = stableAssetId(BUCKET, key);
    const prefix = assetPrefix(assetId);

    const existing = await readJSON(`${prefix}manifest.json`);

    if (existing) {
      if (existing.latest_hash === hash) {
        return res.json({
          asset_id: assetId,
          action: "already_anchored",
          hash,
          events_count: existing.events.length,
          verify_url: `/api/assets/${assetId}/verify`,
        });
      }
    }

    // Create genesis from hash alone (no file upload)
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();

    const mediaAsset = {
      schema_version: SCHEMA_VERSION,
      asset_id: assetId,
      created_at: now,
      original_hash: hash,
      current_hash: hash,
      origin: { ingest_source: "client_anchor", anchor_only: true },
      content: {
        content_type: content_type || "unknown",
        byte_size: size || 0,
        filename: filename || "unknown",
      },
      refs: { proof_prefix_uri: `s3://${BUCKET}/${prefix}` },
    };

    const chainEvent = {
      schema_version: SCHEMA_VERSION,
      event_id: eventId,
      asset_id: assetId,
      timestamp: now,
      event_type: "ingest",
      transformation: "client_genesis_anchor",
      previous_hash: null,
      new_hash: hash,
      inputs: [],
      outputs: [],
      actor: { type: "human", id: "client", display: "Client-side anchor" },
      tool: { name: "provenance-web", version: SCHEMA_VERSION },
    };

    const manifest = {
      schema_version: SCHEMA_VERSION,
      asset_id: assetId,
      events: [eventId],
      latest_hash: hash,
      latest_event_id: eventId,
      updated_at: now,
    };

    await Promise.all([
      writeJSON(`${prefix}mediaasset.json`, mediaAsset),
      writeJSON(`${prefix}events/${eventId}.json`, chainEvent),
      writeJSON(`${prefix}manifest.json`, manifest),
    ]);

    res.json({
      asset_id: assetId,
      action: "genesis",
      hash,
      events_count: 1,
      verify_url: `/api/assets/${assetId}/verify`,
    });
  } catch (e) {
    console.error("Anchor error:", e);
    res.status(500).json({ error: "Anchor failed", detail: e.message });
  }
});

// List all assets
app.get("/api/assets", async (req, res) => {
  try {
    const prefix = `${PROOF_PREFIX}assets/`;
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: "/" }));

    const assetIds = (resp.CommonPrefixes || []).map(p =>
      p.Prefix.replace(prefix, "").replace("/", "")
    );

    const assets = [];
    for (const id of assetIds) {
      const mediaAsset = await readJSON(`${prefix}${id}/mediaasset.json`);
      const manifest = await readJSON(`${prefix}${id}/manifest.json`);
      if (mediaAsset && manifest) {
        assets.push({
          asset_id: id,
          filename: mediaAsset.content?.filename,
          original_hash: mediaAsset.original_hash,
          current_hash: mediaAsset.current_hash,
          events_count: manifest.events.length,
          created_at: mediaAsset.created_at,
          updated_at: manifest.updated_at,
          verify_url: `/api/assets/${id}/verify`,
        });
      }
    }

    res.json({ assets, total: assets.length });
  } catch (e) {
    console.error("List error:", e);
    res.status(500).json({ error: "Failed to list assets", detail: e.message });
  }
});

// Get asset details
app.get("/api/assets/:id", async (req, res) => {
  try {
    const assetId = req.params.id;
    const prefix = assetPrefix(assetId);

    const [mediaAsset, manifest] = await Promise.all([
      readJSON(`${prefix}mediaasset.json`),
      readJSON(`${prefix}manifest.json`),
    ]);

    if (!mediaAsset || !manifest) {
      return res.status(404).json({ error: "Asset not found" });
    }

    // Load all events
    const events = [];
    for (const eventId of manifest.events) {
      const event = await readJSON(`${prefix}events/${eventId}.json`);
      if (event) events.push(event);
    }

    res.json({
      asset: mediaAsset,
      manifest,
      events,
      verify_url: `/api/assets/${assetId}/verify`,
    });
  } catch (e) {
    console.error("Asset detail error:", e);
    res.status(500).json({ error: "Failed to get asset", detail: e.message });
  }
});

// Verify asset
app.get("/api/assets/:id/verify", async (req, res) => {
  try {
    const result = await verifyAsset(req.params.id);
    res.json(result);
  } catch (e) {
    console.error("Verify error:", e);
    res.status(500).json({ error: "Verification failed", detail: e.message });
  }
});

// Verify by hash (lookup)
app.get("/api/verify", async (req, res) => {
  try {
    const hash = req.query.hash?.toLowerCase();
    if (!hash || hash.length !== 64) {
      return res.status(400).json({ error: "Provide ?hash=<64-char SHA-256 hex>" });
    }

    // Scan all assets for matching hash
    const prefix = `${PROOF_PREFIX}assets/`;
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: "/" }));
    const assetIds = (resp.CommonPrefixes || []).map(p =>
      p.Prefix.replace(prefix, "").replace("/", "")
    );

    for (const id of assetIds) {
      const manifest = await readJSON(`${prefix}${id}/manifest.json`);
      if (!manifest) continue;

      // Check if hash matches current or any event
      if (manifest.latest_hash === hash) {
        const result = await verifyAsset(id);
        return res.json({ match: "current", ...result });
      }

      // Check individual events
      for (const eventId of manifest.events) {
        const event = await readJSON(`${prefix}${id}/events/${eventId}.json`);
        if (event && (event.new_hash === hash || event.previous_hash === hash)) {
          const result = await verifyAsset(id);
          return res.json({ match: "historical", matched_event: eventId, ...result });
        }
      }
    }

    res.status(404).json({
      hash,
      chain_status: "NOT_FOUND",
      message: "No provenance record found for this hash",
    });
  } catch (e) {
    console.error("Hash verify error:", e);
    res.status(500).json({ error: "Verification failed", detail: e.message });
  }
});

// ---------------------------------------------------------------------------
// Serve web UI
// ---------------------------------------------------------------------------
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "web")));

// Fallback to index.html for SPA
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "web", "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`◈ Provenance Layer API running on port ${PORT}`);
  console.log(`  Bucket: ${BUCKET}`);
  console.log(`  Region: ${REGION}`);
  console.log(`  Endpoints:`);
  console.log(`    POST /api/upload         Upload file`);
  console.log(`    POST /api/anchor         Anchor by hash (no upload)`);
  console.log(`    GET  /api/assets         List assets`);
  console.log(`    GET  /api/assets/:id     Asset details`);
  console.log(`    GET  /api/assets/:id/verify  Verify chain`);
  console.log(`    GET  /api/verify?hash=   Lookup by hash`);
  console.log(`    GET  /api/health         Health check`);
});
