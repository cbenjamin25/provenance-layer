/**
 * Provenance Layer — Serverless API (Lambda Function URL)
 *
 * Single Lambda handling all API routes via Function URL.
 * No API Gateway needed — Function URL provides HTTPS directly.
 */

import crypto from "crypto";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const BUCKET = process.env.BUCKET || "provenance-layer-media-cb";
const REGION = process.env.AWS_REGION || "us-east-1";
const MEDIA_PREFIX = "media/";
const PROOF_PREFIX = "proofs/";
const SCHEMA_VERSION = "1.0";
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25MB

const s3 = new S3Client({ region: REGION });

// ---------------------------------------------------------------------------
// Rate limiting (per-Lambda instance, resets on cold start)
// ---------------------------------------------------------------------------
const rateLimits = new Map();
function checkRate(ip, type, max) {
  const key = `${type}:${ip}`;
  const now = Date.now();
  const entry = rateLimits.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  rateLimits.set(key, entry);
  return entry.count <= max;
}

// ---------------------------------------------------------------------------
// S3 Helpers
// ---------------------------------------------------------------------------
async function readJSON(key) {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await resp.Body.transformToString();
    return JSON.parse(body);
  } catch (e) {
    const code = e.name || e.$metadata?.httpStatusCode;
    if (code === "NoSuchKey" || code === "AccessDenied" || code === 404) return null;
    throw e;
  }
}

async function writeJSON(key, data) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json",
  }));
}

async function putFile(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer,
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
async function createGenesis(key, digest, fileSize, contentType) {
  const assetId = stableAssetId(BUCKET, key);
  const prefix = assetPrefix(assetId);
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();

  const mediaAsset = {
    schema_version: SCHEMA_VERSION, asset_id: assetId, created_at: now,
    original_hash: digest, current_hash: digest,
    origin: { ingest_source: "api_upload", bucket: BUCKET, key },
    content: { content_type: contentType, byte_size: fileSize, filename: key.split("/").pop() },
    refs: { genesis_object_uri: `s3://${BUCKET}/${key}`, proof_prefix_uri: `s3://${BUCKET}/${prefix}` },
  };

  const chainEvent = {
    schema_version: SCHEMA_VERSION, event_id: eventId, asset_id: assetId,
    timestamp: now, event_type: "ingest", transformation: "genesis_anchor",
    previous_hash: null, new_hash: digest,
    inputs: [{ uri: `s3://${BUCKET}/${key}`, hash: digest }],
    outputs: [{ uri: `s3://${BUCKET}/${key}`, hash: digest }],
    actor: { type: "service", id: "provenance-api", display: "Provenance Layer API" },
    tool: { name: "provenance-api", version: SCHEMA_VERSION },
  };

  const manifest = {
    schema_version: SCHEMA_VERSION, asset_id: assetId,
    events: [eventId], latest_hash: digest, latest_event_id: eventId, updated_at: now,
  };

  await Promise.all([
    writeJSON(`${prefix}mediaasset.json`, mediaAsset),
    writeJSON(`${prefix}events/${eventId}.json`, chainEvent),
    writeJSON(`${prefix}manifest.json`, manifest),
  ]);

  return { mediaAsset, chainEvent, manifest, action: "genesis" };
}

async function appendChainEvent(key, assetId, digest, fileSize, contentType) {
  const prefix = assetPrefix(assetId);
  const [manifest, mediaAsset] = await Promise.all([
    readJSON(`${prefix}manifest.json`), readJSON(`${prefix}mediaasset.json`),
  ]);

  if (!manifest || !mediaAsset) return createGenesis(key, digest, fileSize, contentType);
  if (manifest.latest_hash === digest) return { mediaAsset, chainEvent: null, manifest, action: "skipped_identical" };

  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const previousHash = manifest.latest_hash;

  const chainEvent = {
    schema_version: SCHEMA_VERSION, event_id: eventId, asset_id: assetId,
    timestamp: now, event_type: "transform", transformation: "re_upload",
    previous_hash: previousHash, new_hash: digest,
    inputs: [{ uri: `s3://${BUCKET}/${key}`, hash: previousHash }],
    outputs: [{ uri: `s3://${BUCKET}/${key}`, hash: digest }],
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
      schema_version: SCHEMA_VERSION, asset_id: assetId,
      verified_at: new Date().toISOString(), chain_valid: false,
      chain_status: "NOT_FOUND", events_checked: 0,
      errors: [{ error: "manifest_not_found" }],
    };
  }

  const mediaAsset = await readJSON(`${prefix}mediaasset.json`);
  const errors = [];
  const events = [];
  let expectedPrev = null;

  for (let i = 0; i < manifest.events.length; i++) {
    const event = await readJSON(`${prefix}events/${manifest.events[i]}.json`);
    if (!event) { errors.push({ error: "event_not_found", event_index: i }); continue; }
    events.push(event);

    if (i === 0 && event.previous_hash !== null) {
      errors.push({ error: "genesis_has_previous_hash", event_id: event.event_id });
    } else if (i > 0 && event.previous_hash !== expectedPrev) {
      errors.push({ error: "chain_break", event_index: i, expected: expectedPrev, actual: event.previous_hash });
    }
    expectedPrev = event.new_hash;
  }

  if (events.length && events[events.length - 1].new_hash !== manifest.latest_hash) {
    errors.push({ error: "manifest_hash_mismatch" });
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
        errors.push({ error: "live_file_tampered", live_hash: liveHash, chain_tip: manifest.latest_hash });
      }
    } catch (e) { /* file may be deleted */ }
  }

  const record = {
    schema_version: SCHEMA_VERSION, asset_id: assetId,
    verified_at: new Date().toISOString(),
    chain_valid: errors.length === 0,
    chain_status: errors.length === 0 ? "VERIFIED" : "TAMPERED",
    events_checked: events.length,
    latest_hash: manifest.latest_hash, latest_event_id: manifest.latest_event_id,
    live_file_hash: liveHash, errors,
    verifier: { service: "provenance-api", version: SCHEMA_VERSION },
  };

  await writeJSON(`${prefix}verification/latest.json`, record).catch(() => {});
  return { ...record, events, mediaAsset };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleHealth() {
  return { statusCode: 200, body: { status: "ok", service: "provenance-layer-api", version: SCHEMA_VERSION } };
}

async function handleListAssets() {
  const prefix = `${PROOF_PREFIX}assets/`;
  const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: "/" }));
  const assetIds = (resp.CommonPrefixes || []).map(p => p.Prefix.replace(prefix, "").replace("/", ""));

  const assets = [];
  for (const id of assetIds) {
    const [ma, mf] = await Promise.all([readJSON(`${prefix}${id}/mediaasset.json`), readJSON(`${prefix}${id}/manifest.json`)]);
    if (ma && mf) {
      assets.push({
        asset_id: id, filename: ma.content?.filename, original_hash: ma.original_hash,
        current_hash: ma.current_hash, events_count: mf.events.length,
        created_at: ma.created_at, updated_at: mf.updated_at, verify_url: `/api/assets/${id}/verify`,
      });
    }
  }
  return { statusCode: 200, body: { assets, total: assets.length } };
}

async function handleGetAsset(assetId) {
  const prefix = assetPrefix(assetId);
  const [ma, mf] = await Promise.all([readJSON(`${prefix}mediaasset.json`), readJSON(`${prefix}manifest.json`)]);
  if (!ma || !mf) return { statusCode: 404, body: { error: "Asset not found" } };

  const events = [];
  for (const eid of mf.events) {
    const ev = await readJSON(`${prefix}events/${eid}.json`);
    if (ev) events.push(ev);
  }
  return { statusCode: 200, body: { asset: ma, manifest: mf, events, verify_url: `/api/assets/${assetId}/verify` } };
}

async function handleVerifyAsset(assetId) {
  const result = await verifyAsset(assetId);
  return { statusCode: 200, body: result };
}

async function handleVerifyHash(hash) {
  if (!hash || hash.length !== 64) return { statusCode: 400, body: { error: "Provide ?hash=<64-char SHA-256>" } };

  const prefix = `${PROOF_PREFIX}assets/`;
  const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: "/" }));
  const assetIds = (resp.CommonPrefixes || []).map(p => p.Prefix.replace(prefix, "").replace("/", ""));

  for (const id of assetIds) {
    const mf = await readJSON(`${prefix}${id}/manifest.json`);
    if (!mf) continue;
    if (mf.latest_hash === hash) {
      const result = await verifyAsset(id);
      return { statusCode: 200, body: { match: "current", ...result } };
    }
    for (const eid of mf.events) {
      const ev = await readJSON(`${prefix}${id}/events/${eid}.json`);
      if (ev && (ev.new_hash === hash || ev.previous_hash === hash)) {
        const result = await verifyAsset(id);
        return { statusCode: 200, body: { match: "historical", matched_event: eid, ...result } };
      }
    }
  }
  return { statusCode: 404, body: { hash, chain_status: "NOT_FOUND", message: "No provenance record found" } };
}

async function handleUpload(body, contentType) {
  // Parse multipart — extract file from base64 body
  // Lambda Function URLs send the body as base64 for binary
  const buffer = Buffer.from(body, "base64");

  if (buffer.length > MAX_UPLOAD_SIZE) {
    return { statusCode: 413, body: { error: "File too large (max 25MB)" } };
  }

  // For multipart, we need to parse the boundary
  const boundary = contentType?.match(/boundary=(.+)/)?.[1];
  if (!boundary) {
    return { statusCode: 400, body: { error: "Missing multipart boundary" } };
  }

  // Simple multipart parser
  const parts = parseMultipart(buffer, boundary);
  const filePart = parts.find(p => p.name === "file");
  if (!filePart) {
    return { statusCode: 400, body: { error: "No file field in upload" } };
  }

  const filename = filePart.filename || "upload";
  const key = `${MEDIA_PREFIX}uploads/${Date.now()}-${filename}`;
  const digest = sha256(filePart.data);
  const assetId = stableAssetId(BUCKET, key);

  await putFile(key, filePart.data, filePart.contentType);

  const existing = await readJSON(`${assetPrefix(assetId)}manifest.json`);
  let result;
  if (!existing) {
    result = await createGenesis(key, digest, filePart.data.length, filePart.contentType);
  } else {
    result = await appendChainEvent(key, assetId, digest, filePart.data.length, filePart.contentType);
  }

  return {
    statusCode: 200,
    body: {
      asset_id: assetId, action: result.action, hash: digest, key,
      events_count: result.manifest.events.length, verify_url: `/api/assets/${assetId}/verify`,
    },
  };
}

async function handleAnchor(body) {
  const { hash, filename, size, content_type } = JSON.parse(body);
  if (!hash || hash.length !== 64) return { statusCode: 400, body: { error: "Invalid SHA-256 hash" } };

  const key = `${MEDIA_PREFIX}anchored/${hash.slice(0, 8)}/${filename || "unknown"}`;
  const assetId = stableAssetId(BUCKET, key);
  const prefix = assetPrefix(assetId);
  const existing = await readJSON(`${prefix}manifest.json`);

  if (existing && existing.latest_hash === hash) {
    return { statusCode: 200, body: { asset_id: assetId, action: "already_anchored", hash, events_count: existing.events.length } };
  }

  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();

  await Promise.all([
    writeJSON(`${prefix}mediaasset.json`, {
      schema_version: SCHEMA_VERSION, asset_id: assetId, created_at: now,
      original_hash: hash, current_hash: hash,
      origin: { ingest_source: "client_anchor", anchor_only: true },
      content: { content_type: content_type || "unknown", byte_size: size || 0, filename: filename || "unknown" },
    }),
    writeJSON(`${prefix}events/${eventId}.json`, {
      schema_version: SCHEMA_VERSION, event_id: eventId, asset_id: assetId,
      timestamp: now, event_type: "ingest", transformation: "client_genesis_anchor",
      previous_hash: null, new_hash: hash, inputs: [], outputs: [],
      actor: { type: "human", id: "client" }, tool: { name: "provenance-web", version: SCHEMA_VERSION },
    }),
    writeJSON(`${prefix}manifest.json`, {
      schema_version: SCHEMA_VERSION, asset_id: assetId,
      events: [eventId], latest_hash: hash, latest_event_id: eventId, updated_at: now,
    }),
  ]);

  return { statusCode: 200, body: { asset_id: assetId, action: "genesis", hash, events_count: 1 } };
}

// ---------------------------------------------------------------------------
// Multipart parser (minimal)
// ---------------------------------------------------------------------------
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  let pos = buffer.indexOf(boundaryBuf);
  while (pos !== -1) {
    const start = pos + boundaryBuf.length + 2; // skip \r\n
    const nextBoundary = buffer.indexOf(boundaryBuf, start);
    if (nextBoundary === -1) break;

    const partData = buffer.subarray(start, nextBoundary - 2); // trim trailing \r\n
    const headerEnd = partData.indexOf("\r\n\r\n");
    if (headerEnd === -1) { pos = nextBoundary; continue; }

    const headers = partData.subarray(0, headerEnd).toString();
    const body = partData.subarray(headerEnd + 4);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const ctMatch = headers.match(/Content-Type:\s*(.+)/i);

    parts.push({
      name: nameMatch?.[1],
      filename: filenameMatch?.[1],
      contentType: ctMatch?.[1]?.trim(),
      data: body,
    });

    pos = nextBoundary;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Static file serving (embedded web UI)
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "web");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(path) {
  const ext = path.match(/\.[^.]+$/)?.[0] || ".html";
  const filePath = join(WEB_DIR, path === "/" ? "index.html" : path);

  if (!existsSync(filePath)) {
    // SPA fallback
    const indexPath = join(WEB_DIR, "index.html");
    if (existsSync(indexPath)) {
      return {
        statusCode: 200,
        headers: { "content-type": "text/html" },
        body: readFileSync(indexPath, "utf8"),
        isBase64Encoded: false,
      };
    }
    return { statusCode: 404, body: { error: "Not found" } };
  }

  const content = readFileSync(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const isText = mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript");

  return {
    statusCode: 200,
    headers: { "content-type": mime },
    body: isText ? content.toString("utf8") : content.toString("base64"),
    isBase64Encoded: !isText,
  };
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------
export async function handler(event) {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const query = event.queryStringParameters || {};
  const ip = event.requestContext?.http?.sourceIp || "unknown";
  const contentType = event.headers?.["content-type"] || "";

  try {
    // --- API routes ---
    if (path === "/api/health" && method === "GET") {
      return respond(await handleHealth());
    }

    if (path === "/api/assets" && method === "GET") {
      if (!checkRate(ip, "read", 60)) return respond({ statusCode: 429, body: { error: "Rate limited" } });
      return respond(await handleListAssets());
    }

    if (path.match(/^\/api\/assets\/[a-f0-9]+\/verify$/) && method === "GET") {
      if (!checkRate(ip, "read", 60)) return respond({ statusCode: 429, body: { error: "Rate limited" } });
      const assetId = path.split("/")[3];
      return respond(await handleVerifyAsset(assetId));
    }

    if (path.match(/^\/api\/assets\/[a-f0-9]+$/) && method === "GET") {
      if (!checkRate(ip, "read", 60)) return respond({ statusCode: 429, body: { error: "Rate limited" } });
      const assetId = path.split("/")[3];
      return respond(await handleGetAsset(assetId));
    }

    if (path === "/api/verify" && method === "GET") {
      if (!checkRate(ip, "read", 60)) return respond({ statusCode: 429, body: { error: "Rate limited" } });
      return respond(await handleVerifyHash(query.hash?.toLowerCase()));
    }

    if (path === "/api/upload" && method === "POST") {
      if (!checkRate(ip, "upload", 10)) return respond({ statusCode: 429, body: { error: "Rate limited" } });
      return respond(await handleUpload(event.body, contentType));
    }

    if (path === "/api/anchor" && method === "POST") {
      if (!checkRate(ip, "upload", 10)) return respond({ statusCode: 429, body: { error: "Rate limited" } });
      const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
      return respond(await handleAnchor(body));
    }

    // --- Static files ---
    if (method === "GET" && !path.startsWith("/api/")) {
      return serveStatic(path);
    }

    return respond({ statusCode: 404, body: { error: "Not found" } });

  } catch (e) {
    console.error("Handler error:", e);
    return respond({ statusCode: 500, body: { error: "Internal server error", detail: e.message } });
  }
}

function respond({ statusCode, body, headers, isBase64Encoded }) {
  const isJSON = typeof body === "object" && !isBase64Encoded;
  return {
    statusCode,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      ...(isJSON ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: isJSON ? JSON.stringify(body) : body,
    isBase64Encoded: isBase64Encoded || false,
  };
}
