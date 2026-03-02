# @provenance/sdk

Cryptographic media authenticity in three lines of code.

## Install

```bash
npm install @provenance/sdk
```

## Quick Start

```javascript
import { anchor, verify } from '@provenance/sdk'

// Anchor a file — creates a cryptographic genesis record
const proof = await anchor('./photo.jpg')
console.log(proof.asset_id)  // "a1b2c3d4e5f67890"
console.log(proof.hash)      // "sha256..."
console.log(proof.action)    // "genesis"

// Verify a file — checks against the provenance chain
const result = await verify('./photo.jpg')
console.log(result.chain_status)  // "VERIFIED" | "NOT_FOUND" | "TAMPERED"
```

## Full Client

```javascript
import { ProvenanceClient } from '@provenance/sdk'

const client = new ProvenanceClient({
  apiUrl: 'https://your-provenance-api.com',  // optional, defaults to cloud
  apiKey: 'your-api-key',                      // optional, for authenticated access
})

// Upload and anchor
const proof = await client.anchor('./evidence.pdf')

// Anchor by hash only — file never leaves your machine
const record = await client.anchorHash('./classified.doc')

// Verify
const result = await client.verify('./evidence.pdf')

// Verify by asset ID
const chain = await client.verifyAsset('a1b2c3d4e5f67890')

// Get full asset details + chain history
const detail = await client.getAsset('a1b2c3d4e5f67890')

// List all tracked assets
const { assets, total } = await client.listAssets()

// Hash locally without any API call
const hash = await ProvenanceClient.hash('./photo.jpg')
```

## API

### `anchor(input, options?)`

Upload a file and create a provenance record.

- **input**: File path (string), Buffer, Uint8Array, or browser File/Blob
- **options.filename**: Override filename
- **options.contentType**: Override MIME type
- **Returns**: `{ asset_id, action, hash, events_count, verify_url }`

### `anchorHash(input, options?)`

Register provenance by hash only — the file never leaves your machine.

- **input**: File path, Buffer, Uint8Array, Blob, or a 64-char hex hash string
- **Returns**: `{ asset_id, action, hash, events_count }`

### `verify(input)`

Verify a file against its provenance record.

- **input**: File path, Buffer, Uint8Array, Blob, or a 64-char hex hash string
- **Returns**: `{ chain_status, chain_valid, events_checked, ... }`

### `verifyAsset(assetId)`

Walk and verify the full chain for an asset.

### `getAsset(assetId)`

Get full details: metadata, manifest, and all chain events.

### `listAssets()`

List all tracked assets.

### `ProvenanceClient.hash(input)`

Hash a file locally. No API call. Returns SHA-256 hex string.

## Chain Status Values

| Status | Meaning |
|--------|---------|
| `VERIFIED` | File matches the chain. Integrity confirmed. |
| `NOT_FOUND` | No provenance record exists for this hash. |
| `TAMPERED` | Chain is broken or file doesn't match. |

## How It Works

1. **Anchor** — When you anchor a file, the SDK computes a SHA-256 hash and sends it (or the full file) to the Provenance Layer API, which creates a cryptographic genesis record.

2. **Chain** — Every subsequent version creates a new chain event linked to the previous hash: `H0 → H1 → H2 → ... → Hn`. Break any link, verification fails.

3. **Verify** — The SDK hashes your file locally and checks it against the chain. If the hash matches the chain tip, the file is verified. If not, it's been modified.

## Works Everywhere

- ✅ Node.js (file paths, Buffers)
- ✅ Browser (File, Blob, Uint8Array)
- ✅ TypeScript (full type definitions included)
- ✅ ESM and CommonJS

## License

MIT — Cedric Benjamin
