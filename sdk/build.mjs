#!/usr/bin/env node
/**
 * Simple build script — copies ESM source and generates CJS + types.
 * Zero dependencies.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "dist");
mkdirSync(dist, { recursive: true });

// ESM — copy as-is
const esm = readFileSync(join(__dirname, "src/index.mjs"), "utf8");
writeFileSync(join(dist, "index.mjs"), esm);

// CJS — simple transform
let cjs = esm
  .replace(/^export\s+(async\s+)?function\s+(\w+)/gm, "module.exports.$2 = $1function $2")
  .replace(/^export\s+class\s+(\w+)/gm, "const $1 = module.exports.$1 = class $1")
  .replace(/^export\s+default\s+(\w+)/gm, "module.exports.default = $1; module.exports = Object.assign(module.exports.default, module.exports)")
  .replace(/^import\s+(\w+)\s+from\s+"([^"]+)"/gm, 'const $1 = require("$2")')
  .replace(/^import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/gm, (_, names, mod) => {
    const vars = names.split(",").map(n => n.trim());
    return `const { ${vars.join(", ")} } = require("${mod}")`;
  })
  .replace(/const fs = await import\("fs"\)/g, 'const fs = require("fs")')
  .replace(/const path = await import\("path"\)/g, 'const path = require("path")');

writeFileSync(join(dist, "index.js"), cjs);

// TypeScript declarations
const dts = `
export interface AnchorResult {
  asset_id: string;
  action: "genesis" | "chain_appended" | "skipped_identical" | "already_anchored";
  hash: string;
  key?: string;
  events_count: number;
  verify_url: string;
}

export interface VerifyResult {
  schema_version: string;
  asset_id: string;
  verified_at: string;
  chain_valid: boolean;
  chain_status: "VERIFIED" | "TAMPERED" | "NOT_FOUND";
  events_checked: number;
  latest_hash?: string;
  latest_event_id?: string;
  live_file_hash?: string;
  errors: Array<{ error: string; [key: string]: any }>;
  match?: "current" | "historical";
  matched_event?: string;
  events?: ChainEvent[];
  mediaAsset?: MediaAsset;
}

export interface Asset {
  asset_id: string;
  filename: string;
  original_hash: string;
  current_hash: string;
  events_count: number;
  created_at: string;
  updated_at: string;
  verify_url: string;
}

export interface AssetDetail {
  asset: MediaAsset;
  manifest: Manifest;
  events: ChainEvent[];
  verify_url: string;
}

export interface MediaAsset {
  schema_version: string;
  asset_id: string;
  created_at: string;
  original_hash: string;
  current_hash: string;
  origin: Record<string, any>;
  content: { content_type: string; byte_size: number; filename: string };
  refs?: Record<string, any>;
}

export interface ChainEvent {
  schema_version: string;
  event_id: string;
  asset_id: string;
  timestamp: string;
  event_type: string;
  transformation: string;
  previous_hash: string | null;
  new_hash: string;
  inputs: Array<{ uri: string; hash: string }>;
  outputs: Array<{ uri: string; hash: string }>;
  actor: { type: string; id: string; display?: string };
  tool: { name: string; version: string };
}

export interface Manifest {
  schema_version: string;
  asset_id: string;
  events: string[];
  latest_hash: string;
  latest_event_id: string;
  updated_at: string;
}

export interface ClientOptions {
  apiUrl?: string;
  apiKey?: string;
  timeout?: number;
}

export interface AnchorOptions {
  filename?: string;
  contentType?: string;
  size?: number;
}

export declare class ProvenanceClient {
  constructor(options?: ClientOptions);
  anchor(input: string | Buffer | Uint8Array | Blob | File, options?: AnchorOptions): Promise<AnchorResult>;
  anchorHash(input: string | Buffer | Uint8Array | Blob | File, options?: AnchorOptions): Promise<AnchorResult>;
  verify(input: string | Buffer | Uint8Array | Blob | File): Promise<VerifyResult>;
  verifyAsset(assetId: string): Promise<VerifyResult>;
  getAsset(assetId: string): Promise<AssetDetail>;
  listAssets(): Promise<{ assets: Asset[]; total: number }>;
  health(): Promise<{ status: string; service: string; version: string }>;
  static hash(input: string | Buffer | Uint8Array | Blob | File): Promise<string>;
}

export declare function anchor(input: string | Buffer | Uint8Array | Blob | File, options?: ClientOptions & AnchorOptions): Promise<AnchorResult>;
export declare function verify(input: string | Buffer | Uint8Array | Blob | File, options?: ClientOptions): Promise<VerifyResult>;
export declare function hash(input: string | Buffer | Uint8Array | Blob | File): Promise<string>;

export default ProvenanceClient;
`;

writeFileSync(join(dist, "index.d.ts"), dts.trim() + "\\n");

console.log("✅ Built: dist/index.mjs, dist/index.js, dist/index.d.ts");
