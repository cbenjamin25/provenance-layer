#!/usr/bin/env node
/**
 * Deploy Provenance Layer API as Lambda + Function URL
 * No zip binary needed — uses Node's built-in zlib.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdtempSync, cpSync, rmSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { createDeflateRaw } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const FUNCTION_NAME = "provenance-layer-api";
const REGION = "us-east-1";
const ROLE_ARN = "arn:aws:iam::234680850143:role/provenance-lambda-role";
const BUCKET = "provenance-layer-media-cb";

// ---------------------------------------------------------------------------
// Minimal ZIP creator (no dependencies)
// ---------------------------------------------------------------------------
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

import { deflateRawSync } from "zlib";

async function createZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const useStore = compressed.length >= data.length;
    const compData = useStore ? data : compressed;
    const method = useStore ? 0 : 8;

    // Local file header
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(local, 30);

    localHeaders.push(Buffer.concat([local, compData]));

    // Central directory header
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compData.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length + compData.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const centralDirOffset = offset;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

function collectFiles(dir, base = "") {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === ".venv" || entry === "__pycache__") continue;
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, rel));
    } else {
      files.push({ name: rel, data: readFileSync(full) });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("📦 Packaging Lambda...");

  // Build deployment directory
  const tmpDir = mkdtempSync("/tmp/provenance-deploy-");

  // Copy handler as index.mjs
  cpSync(join(__dirname, "lambda-handler.js"), join(tmpDir, "index.mjs"));

  // Copy web directory
  cpSync(join(ROOT, "web"), join(tmpDir, "web"), { recursive: true });

  // Create package.json
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
    type: "module",
    dependencies: { "@aws-sdk/client-s3": "^3.0.0" }
  }));

  // Install deps
  console.log("Installing dependencies...");
  execSync("npm install --production 2>/dev/null", { cwd: tmpDir, stdio: "pipe" });

  // Collect and zip
  console.log("Creating zip...");
  const files = collectFiles(tmpDir);
  const zipBuffer = await createZip(files);
  console.log(`📦 Package: ${files.length} files, ${(zipBuffer.length / 1024 / 1024).toFixed(1)}MB`);

  // Deploy
  const { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand,
    GetFunctionCommand, CreateFunctionUrlConfigCommand, GetFunctionUrlConfigCommand,
    AddPermissionCommand, UpdateFunctionConfigurationCommand, waitUntilFunctionUpdatedV2
  } = await import("@aws-sdk/client-lambda");

  const lambda = new LambdaClient({ region: REGION });

  let functionExists = false;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    functionExists = true;
  } catch (e) {}

  if (functionExists) {
    console.log("Updating existing function...");
    await lambda.send(new UpdateFunctionCodeCommand({
      FunctionName: FUNCTION_NAME, ZipFile: zipBuffer,
    }));
    console.log("Waiting for update...");
    await new Promise(r => setTimeout(r, 5000));
    try {
      await lambda.send(new UpdateFunctionConfigurationCommand({
        FunctionName: FUNCTION_NAME,
        Timeout: 30, MemorySize: 256,
        Environment: { Variables: { BUCKET, AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1" } },
      }));
    } catch (e) {
      console.log("Config update pending, retrying...");
      await new Promise(r => setTimeout(r, 5000));
      await lambda.send(new UpdateFunctionConfigurationCommand({
        FunctionName: FUNCTION_NAME,
        Timeout: 30, MemorySize: 256,
        Environment: { Variables: { BUCKET, AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1" } },
      }));
    }
  } else {
    console.log("Creating new function...");
    await lambda.send(new CreateFunctionCommand({
      FunctionName: FUNCTION_NAME,
      Runtime: "nodejs22.x",
      Role: ROLE_ARN,
      Handler: "index.handler",
      Code: { ZipFile: zipBuffer },
      Timeout: 30, MemorySize: 256,
      Environment: { Variables: { BUCKET, AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1" } },
      PackageType: "Zip",
    }));
    console.log("Waiting for function to be active...");
    await new Promise(r => setTimeout(r, 8000));
  }

  // Function URL
  let url;
  try {
    const existing = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: FUNCTION_NAME }));
    url = existing.FunctionUrl;
    console.log("Function URL already exists");
  } catch (e) {
    console.log("Creating function URL...");
    const resp = await lambda.send(new CreateFunctionUrlConfigCommand({
      FunctionName: FUNCTION_NAME,
      AuthType: "NONE",
      Cors: {
        AllowOrigins: ["*"],
        AllowMethods: ["GET", "POST"],
        AllowHeaders: ["content-type"],
      },
    }));
    url = resp.FunctionUrl;

    try {
      await lambda.send(new AddPermissionCommand({
        FunctionName: FUNCTION_NAME,
        StatementId: "FunctionURLAllowPublicAccess",
        Action: "lambda:InvokeFunctionUrl",
        Principal: "*",
        FunctionUrlAuthType: "NONE",
      }));
    } catch (e) {
      if (!e.message?.includes("already exists")) throw e;
    }
  }

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });

  console.log("");
  console.log("✅ Deployed!");
  console.log(`🌐 ${url}`);
  console.log(`🔍 ${url}api/health`);
  console.log(`📋 ${url}api/assets`);
}

main().catch(e => { console.error("❌ Deploy failed:", e.message || e); process.exit(1); });
