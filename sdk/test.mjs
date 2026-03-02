#!/usr/bin/env node
/**
 * Provenance SDK — Integration Tests
 * Tests against the live API.
 */
import { ProvenanceClient, anchor, verify, hash } from "./src/index.mjs";
import { writeFileSync, unlinkSync } from "fs";

const API = process.env.PROVENANCE_API || "https://c2yaomspxmga3btoxh4kjpjqnm0zbkbm.lambda-url.us-east-1.on.aws";

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

async function test(name, fn) {
  console.log(`\n🧪 ${name}`);
  try {
    await fn();
  } catch (e) {
    console.log(`  ❌ THREW: ${e.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
const client = new ProvenanceClient({ apiUrl: API });

await test("Health check", async () => {
  const result = await client.health();
  assert(result.status === "ok", "status is ok");
  assert(result.service === "provenance-layer-api", "correct service name");
});

await test("Hash a buffer", async () => {
  const h = await ProvenanceClient.hash(Buffer.from("hello provenance"));
  assert(h.length === 64, "hash is 64 hex chars");
  assert(typeof h === "string", "hash is a string");
});

await test("Hash a file", async () => {
  const testFile = "/tmp/provenance-sdk-test.txt";
  writeFileSync(testFile, `SDK test ${Date.now()}`);
  const h = await hash(testFile);
  assert(h.length === 64, "file hash is 64 hex chars");
  unlinkSync(testFile);
});

await test("Anchor a file (upload)", async () => {
  const testFile = "/tmp/provenance-sdk-upload-test.txt";
  const content = `SDK upload test ${Date.now()}`;
  writeFileSync(testFile, content);

  const result = await client.anchor(testFile);
  assert(result.asset_id, "got asset_id");
  assert(result.hash, "got hash");
  assert(result.action === "genesis" || result.action === "chain_appended", "action is genesis or chain_appended");
  assert(result.verify_url, "got verify_url");

  // Store for later tests
  globalThis._testAssetId = result.asset_id;
  globalThis._testHash = result.hash;
  unlinkSync(testFile);
});

await test("Anchor by hash only", async () => {
  const h = await hash(Buffer.from(`anchor-hash-test-${Date.now()}`));
  const result = await client.anchorHash(h, { filename: "sdk-test-hash.txt" });
  assert(result.asset_id, "got asset_id");
  assert(result.action === "genesis" || result.action === "already_anchored", "correct action");
});

await test("Verify by hash (convenience)", async () => {
  if (!globalThis._testHash) { console.log("  ⏭️  Skipped (no test hash)"); return; }
  const result = await verify(globalThis._testHash);
  assert(result.chain_status === "VERIFIED" || result.match, "verified or matched");
});

await test("Verify asset by ID", async () => {
  if (!globalThis._testAssetId) { console.log("  ⏭️  Skipped (no test asset)"); return; }
  const result = await client.verifyAsset(globalThis._testAssetId);
  assert(result.chain_valid === true, "chain is valid");
  assert(result.chain_status === "VERIFIED", "status is VERIFIED");
});

await test("Get asset details", async () => {
  if (!globalThis._testAssetId) { console.log("  ⏭️  Skipped (no test asset)"); return; }
  const result = await client.getAsset(globalThis._testAssetId);
  assert(result.asset, "has asset");
  assert(result.events?.length > 0, "has events");
  assert(result.manifest, "has manifest");
});

await test("List all assets", async () => {
  const result = await client.listAssets();
  assert(Array.isArray(result.assets), "assets is array");
  assert(result.total > 0, "has assets");
});

await test("Verify unknown hash returns NOT_FOUND", async () => {
  const fakeHash = "0000000000000000000000000000000000000000000000000000000000000000";
  const result = await client.verify(fakeHash);
  assert(result.chain_status === "NOT_FOUND", "status is NOT_FOUND");
});

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
