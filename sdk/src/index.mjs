/**
 * Provenance Layer SDK
 * 
 * Cryptographic media authenticity in three lines of code.
 * 
 * @example
 * import { ProvenanceClient } from '@provenance/sdk'
 * const client = new ProvenanceClient({ apiKey: 'your-key' })
 * const proof = await client.anchor(file)
 * const result = await client.verify(file)
 */

import crypto from "crypto";

const DEFAULT_API = "https://c2yaomspxmga3btoxh4kjpjqnm0zbkbm.lambda-url.us-east-1.on.aws";

// ---------------------------------------------------------------------------
// Hashing — works in Node and browser
// ---------------------------------------------------------------------------
async function sha256(input) {
  let buffer;

  if (typeof input === "string") {
    // File path (Node only)
    const fs = await import("fs");
    buffer = fs.readFileSync(input);
  } else if (input instanceof Uint8Array || Buffer.isBuffer(input)) {
    buffer = input;
  } else if (typeof Blob !== "undefined" && input instanceof Blob) {
    // Browser File/Blob
    const arrayBuf = await input.arrayBuffer();
    buffer = new Uint8Array(arrayBuf);
  } else {
    throw new Error("Unsupported input type. Pass a file path (string), Buffer, Uint8Array, or Blob.");
  }

  // Node crypto
  if (typeof crypto.createHash === "function") {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  // Browser WebCrypto
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  throw new Error("No SHA-256 implementation available");
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function request(baseUrl, method, path, { body, headers = {}, timeout = 30000 } = {}) {
  const url = `${baseUrl}${path}`;
  const opts = {
    method,
    headers: { ...headers },
  };

  if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Uint8Array)) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }

  // Timeout via AbortController
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  opts.signal = controller.signal;

  try {
    const resp = await fetch(url, opts);
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!resp.ok) {
      const err = new Error(data?.error || data?.message || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ProvenanceClient
// ---------------------------------------------------------------------------
export class ProvenanceClient {
  /**
   * @param {Object} options
   * @param {string} [options.apiUrl] - API base URL (default: Provenance Layer cloud)
   * @param {string} [options.apiKey] - API key for authenticated requests (future)
   * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
   */
  constructor({ apiUrl, apiKey, timeout } = {}) {
    this.apiUrl = (apiUrl || DEFAULT_API).replace(/\/$/, "");
    this.apiKey = apiKey || null;
    this.timeout = timeout || 30000;
  }

  _headers() {
    const h = {};
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Anchor a file — upload and create a genesis anchor or chain event.
   * 
   * @param {string|Buffer|Uint8Array|Blob|File} input - File path, buffer, or browser File
   * @param {Object} [options]
   * @param {string} [options.filename] - Override filename
   * @param {string} [options.contentType] - Override content type
   * @returns {Promise<AnchorResult>}
   * 
   * @example
   * const result = await client.anchor('./photo.jpg')
   * console.log(result.asset_id, result.action, result.hash)
   */
  async anchor(input, { filename, contentType } = {}) {
    let buffer;
    let name = filename || "upload";
    let type = contentType || "application/octet-stream";

    if (typeof input === "string") {
      const fs = await import("fs");
      const path = await import("path");
      buffer = fs.readFileSync(input);
      name = filename || path.basename(input);
      // Guess content type from extension
      const ext = path.extname(input).toLowerCase();
      const mimeMap = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
        ".pdf": "application/pdf", ".txt": "text/plain", ".json": "application/json",
        ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
      type = contentType || mimeMap[ext] || "application/octet-stream";
    } else if (typeof Blob !== "undefined" && input instanceof Blob) {
      const arrayBuf = await input.arrayBuffer();
      buffer = new Uint8Array(arrayBuf);
      name = filename || input.name || "upload";
      type = contentType || input.type || "application/octet-stream";
    } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      buffer = input;
    } else {
      throw new Error("Unsupported input. Pass a file path, Buffer, Uint8Array, or File/Blob.");
    }

    // Build multipart form
    const boundary = `----ProvenanceSDK${Date.now()}`;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(header);
    const footerBuf = Buffer.from(footer);
    const body = Buffer.concat([headerBuf, buffer, footerBuf]);

    return request(this.apiUrl, "POST", "/api/upload", {
      body,
      headers: {
        ...this._headers(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      timeout: this.timeout,
    });
  }

  /**
   * Anchor by hash only — register provenance without uploading the file.
   * The file never leaves your machine.
   * 
   * @param {string|Buffer|Uint8Array|Blob|File} input - File to hash, or a hex hash string
   * @param {Object} [options]
   * @param {string} [options.filename] - Filename for the record
   * @param {number} [options.size] - File size in bytes
   * @param {string} [options.contentType] - Content type
   * @returns {Promise<AnchorResult>}
   * 
   * @example
   * // Hash locally, anchor remotely — file never uploaded
   * const result = await client.anchorHash('./secret-document.pdf')
   */
  async anchorHash(input, { filename, size, contentType } = {}) {
    let hash;
    let name = filename;
    let fileSize = size;

    if (typeof input === "string" && /^[a-f0-9]{64}$/.test(input)) {
      // Already a hash
      hash = input;
    } else {
      // Hash the input
      if (typeof input === "string") {
        const fs = await import("fs");
        const path = await import("path");
        const stat = fs.statSync(input);
        fileSize = fileSize || stat.size;
        name = name || path.basename(input);
      } else if (typeof Blob !== "undefined" && input instanceof Blob) {
        fileSize = fileSize || input.size;
        name = name || input.name;
      }
      hash = await sha256(input);
    }

    return request(this.apiUrl, "POST", "/api/anchor", {
      body: { hash, filename: name || "unknown", size: fileSize || 0, content_type: contentType || "unknown" },
      headers: this._headers(),
      timeout: this.timeout,
    });
  }

  /**
   * Verify a file against its provenance record.
   * Hashes locally and checks the chain.
   * 
   * @param {string|Buffer|Uint8Array|Blob|File} input - File to verify, or a hex hash string
   * @returns {Promise<VerifyResult>}
   * 
   * @example
   * const result = await client.verify('./photo.jpg')
   * if (result.chain_status === 'VERIFIED') { ... }
   */
  async verify(input) {
    let h;
    if (typeof input === "string" && /^[a-f0-9]{64}$/.test(input)) {
      h = input;
    } else {
      h = await sha256(input);
    }

    try {
      return await request(this.apiUrl, "GET", `/api/verify?hash=${h}`, {
        headers: this._headers(),
        timeout: this.timeout,
      });
    } catch (e) {
      if (e.status === 404) {
        return e.body || { hash: h, chain_status: "NOT_FOUND", message: "No provenance record found" };
      }
      throw e;
    }
  }

  /**
   * Verify a specific asset by ID — walks the full chain.
   * 
   * @param {string} assetId - The asset ID
   * @returns {Promise<VerifyResult>}
   */
  async verifyAsset(assetId) {
    return request(this.apiUrl, "GET", `/api/assets/${assetId}/verify`, {
      headers: this._headers(),
      timeout: this.timeout,
    });
  }

  /**
   * Get full details for an asset — metadata, chain events, manifest.
   * 
   * @param {string} assetId - The asset ID
   * @returns {Promise<AssetDetail>}
   */
  async getAsset(assetId) {
    return request(this.apiUrl, "GET", `/api/assets/${assetId}`, {
      headers: this._headers(),
      timeout: this.timeout,
    });
  }

  /**
   * List all tracked assets.
   * 
   * @returns {Promise<{assets: Asset[], total: number}>}
   */
  async listAssets() {
    return request(this.apiUrl, "GET", "/api/assets", {
      headers: this._headers(),
      timeout: this.timeout,
    });
  }

  /**
   * Health check.
   * 
   * @returns {Promise<{status: string, service: string, version: string}>}
   */
  async health() {
    return request(this.apiUrl, "GET", "/api/health", {
      headers: this._headers(),
      timeout: this.timeout,
    });
  }

  // -------------------------------------------------------------------------
  // Convenience — static hash utility
  // -------------------------------------------------------------------------

  /**
   * Hash a file locally without making any API calls.
   * 
   * @param {string|Buffer|Uint8Array|Blob|File} input
   * @returns {Promise<string>} SHA-256 hex digest
   * 
   * @example
   * const hash = await ProvenanceClient.hash('./photo.jpg')
   */
  static async hash(input) {
    return sha256(input);
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

/**
 * Quick anchor — create client and anchor in one call.
 * 
 * @example
 * import { anchor } from '@provenance/sdk'
 * const result = await anchor('./photo.jpg')
 */
export async function anchor(input, options = {}) {
  const client = new ProvenanceClient(options);
  return client.anchor(input, options);
}

/**
 * Quick verify — create client and verify in one call.
 * 
 * @example
 * import { verify } from '@provenance/sdk'
 * const result = await verify('./photo.jpg')
 * console.log(result.chain_status) // 'VERIFIED' | 'NOT_FOUND' | 'TAMPERED'
 */
export async function verify(input, options = {}) {
  const client = new ProvenanceClient(options);
  return client.verify(input, options);
}

/**
 * Quick hash — SHA-256 without any API call.
 */
export async function hash(input) {
  return sha256(input);
}

export default ProvenanceClient;
