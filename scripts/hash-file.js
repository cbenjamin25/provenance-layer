#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/hash-file.js path/to/file
 *
 * Output:
 *   - prints SHA-256 to stdout
 *   - writes a JSON proof into /proofs
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}

const filePath = process.argv[2];
if (!filePath) die("Missing file path. Example: node scripts/hash-file.js ./test.jpg");

if (!fs.existsSync(filePath)) die(`File not found: ${filePath}`);

const absPath = path.resolve(filePath);
const stat = fs.statSync(absPath);
if (!stat.isFile()) die(`Not a file: ${filePath}`);

const hash = crypto.createHash("sha256");
const stream = fs.createReadStream(absPath);

stream.on("data", (chunk) => hash.update(chunk));
stream.on("error", (err) => die(err.message));
stream.on("end", () => {
  const digest = hash.digest("hex");
  const filename = path.basename(absPath);

  const proof = {
    mediaAsset: {
      id: crypto.randomUUID(),
      filename,
      path: absPath,
      sizeBytes: stat.size,
      uploadedAt: new Date().toISOString(),
      hash: { algo: "sha256", value: digest }
    },
    chainEvents: [
      {
        eventType: "hash_generated",
        timestamp: new Date().toISOString(),
        actor: "user",
        details: { algo: "sha256" }
      }
    ],
    verificationRecord: {
      mediaId: null, // you can later set this to mediaAsset.id or real DB id
      status: "HASHED_ONLY"
    }
  };

  const outName = `${filename}.sha256.json`;
  const outPath = path.join(process.cwd(), "proofs", outName);
  fs.writeFileSync(outPath, JSON.stringify(proof, null, 2), "utf8");

  console.log(digest);
  console.log(`Proof written: ${outPath}`);
});
