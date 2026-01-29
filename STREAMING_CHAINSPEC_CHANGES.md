# Streaming Chain Spec Changes

## Problem

When using a forked mainnet state chain spec (500MB-2GB files), zombienet fails with "failed to parse the chain spec" or "failed to write the chain spec".

**Root Cause:** Both `readAndParseChainSpec` and `writeChainSpec` functions used synchronous operations:
1. Reading: `fs.readFileSync()` + `JSONbig.parse()` loads entire file into memory
2. Writing: `JSONbig.stringify()` + `fs.writeFileSync()` stringifies entire object in memory
3. For large files, this causes memory exhaustion (JavaScript heap out of memory)

## Solution

Implement streaming JSON parsing and writing using:
- **`stream-json`** - For streaming JSON parsing (reading)
- **`json-stream-stringify`** - For streaming JSON stringification (writing)
- **Transform stream** - For converting exponential notation to regular numbers

---

## Changes Summary

### 1. Package Dependencies

**File:** `javascript/packages/orchestrator/package.json`

**Add to `dependencies`:**
```json
"json-stream-stringify": "^3.1.6",
"stream-json": "^1.8.0"
```

**Add to `devDependencies`:**
```json
"@types/stream-json": "^1.7.8"
```

---

### 2. Core Chain Spec Changes

**File:** `javascript/packages/orchestrator/src/chainSpec.ts`

#### 2a. Update imports

**Add these imports:**
```typescript
import { Transform } from "stream";
import { parser } from "stream-json";
import Assembler from "stream-json/Assembler";
import { JsonStreamStringify } from "json-stream-stringify";
```

**Keep (still needed for some operations):**
```typescript
const JSONbig = require("json-bigint")({ useNativeBigInt: true });
```

#### 2b. Add streaming parse function

**Add:**
```typescript
async function parseChainSpecStream(specPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(specPath);
    const jsonParser = parser();
    const assembler = Assembler.connectTo(jsonParser);

    assembler.on("done", (asm: any) => resolve(asm.current));
    jsonParser.on("error", (err: Error) => reject(err));
    readStream.on("error", (err: Error) => reject(err));

    readStream.pipe(jsonParser);
  });
}
```

#### 2c. Update `readAndParseChainSpec` function

**Replace:**
```typescript
export function readAndParseChainSpec(specPath: string) {
  const rawdata = fs.readFileSync(specPath);
  let chainSpec;
  try {
    chainSpec = JSONbig.parse(rawdata);
    return chainSpec;
  } catch {
    console.error(
      `\n\t\t  ${decorators.red("  ⚠ failed to parse the chain spec")}`,
    );
    process.exit(1);
  }
}
```

**With:**
```typescript
export async function readAndParseChainSpec(specPath: string): Promise<any> {
  try {
    const chainSpec = await parseChainSpecStream(specPath);
    return chainSpec;
  } catch (err: any) {
    console.error(
      `\n\t\t  ${decorators.red("  ⚠ failed to parse the chain spec")}`,
    );
    console.error(`\t\t  Error: ${err.message}`);
    process.exit(1);
  }
}
```

#### 2d. Update `writeChainSpec` function

**Replace:**
```typescript
export function writeChainSpec(specPath: string, chainSpec: any) {
  try {
    const data = JSONbig.stringify(chainSpec, null, 2);
    fs.writeFileSync(specPath, convertExponentials(data));
  } catch {
    console.error(
      `\n\t\t  ${decorators.reverse(
        decorators.red("  ⚠ failed to write the chain spec with path: "),
      )} ${specPath}`,
    );
    process.exit(1);
  }
}
```

**With:**
```typescript
export async function writeChainSpec(
  specPath: string,
  chainSpec: any,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(specPath);
    // Replacer function to handle BigInt values which are not natively supported in JSON
    const replacer = (key: string, value: any) =>
      typeof value === "bigint" ? Number(value) : value;
    const jsonStream = new JsonStreamStringify(chainSpec, replacer);

    // Transform stream to convert exponential notation to regular numbers
    // (e.g., 1e+20 -> 100000000000000000000)
    // Note: Inline implementation used instead of convertExponentials from utils
    // due to pkg bundling issues with cross-package imports in the binary
    const exponentialTransform = new Transform({
      transform(chunk, encoding, callback) {
        const str = chunk.toString();
        const converted = str.replace(/e\+[0-9]+/gi, function (exp: string) {
          const e = parseInt(exp.split("+")[1], 10);
          return "0".repeat(e);
        });
        callback(null, converted);
      },
    });

    writeStream.on("error", (err) => {
      console.error(
        `\n\t\t  ${decorators.reverse(
          decorators.red("  ⚠ failed to write the chain spec with path: "),
        )} ${specPath}`,
      );
      reject(err);
    });

    writeStream.on("finish", resolve);

    jsonStream.on("error", (err: Error) => {
      console.error(
        `\n\t\t  ${decorators.reverse(
          decorators.red("  ⚠ failed to stringify the chain spec: "),
        )} ${err.message}`,
      );
      reject(err);
    });

    exponentialTransform.on("error", (err: Error) => {
      console.error(
        `\n\t\t  ${decorators.reverse(
          decorators.red("  ⚠ failed to transform the chain spec: "),
        )} ${err.message}`,
      );
      reject(err);
    });

    jsonStream.pipe(exponentialTransform).pipe(writeStream);
  });
}
```

**Key points:**
- Uses `JsonStreamStringify` with a BigInt replacer to handle BigInt values
- Pipes through a Transform stream that converts exponential notation (e.g., `1e+20`) to regular numbers (e.g., `100000000000000000000`)
- This is necessary because Polkadot's chain spec parser doesn't handle exponential notation

#### 2e. Update all callers to use `await`

Add `await` before `readAndParseChainSpec(...)` and `writeChainSpec(...)` in these functions:
- `clearAuthorities` (also make function async)
- `addBalances`
- `addAuthority`
- `addStaking`
- `addCollatorSelection`
- `addAuraAuthority`
- `addGrandpaAuthority`
- `generateNominators`
- `addParachainToGenesis`
- `changeGenesisConfig`
- `addBootNodes`
- `addHrmpChannelsToGenesis`
- `customizePlainRelayChain`

---

### 3. Paras.ts Changes

**File:** `javascript/packages/orchestrator/src/paras.ts`

Add `await` before `readAndParseChainSpec(...)` and `writeChainSpec(...)` calls.

---

### 4. Orchestrator.ts Changes

**File:** `javascript/packages/orchestrator/src/orchestrator.ts`

Add `await` before `readAndParseChainSpec(...)` and `writeChainSpec(...)` calls.

---

### 5. Chain Decorator Changes

All chain decorators need `await` added for both `readAndParseChainSpec` and `writeChainSpec`:

- `src/chain-decorators/moonbeam.ts`
- `src/chain-decorators/equilibrium.ts`
- `src/chain-decorators/local-v.ts`
- `src/chain-decorators/mainnet-local-v.ts`
- `src/chain-decorators/oak.ts`
- `src/chain-decorators/mangata.ts`
- `src/chain-decorators/generic-evm.ts`

---

## Build & Package

```bash
cd /path/to/zombienet/javascript

# Install dependencies
npm install

# Build
npm run build

# Package for macOS arm64
cd packages/cli
npm run package:macos:arm64
```

Binary output: `javascript/bins/zombienet-macos-arm64`

---

## Quick Reference: All Files Modified

1. `javascript/packages/orchestrator/package.json`
2. `javascript/packages/orchestrator/src/chainSpec.ts`
3. `javascript/packages/orchestrator/src/paras.ts`
4. `javascript/packages/orchestrator/src/orchestrator.ts`
5. `javascript/packages/orchestrator/src/chain-decorators/moonbeam.ts`
6. `javascript/packages/orchestrator/src/chain-decorators/equilibrium.ts`
7. `javascript/packages/orchestrator/src/chain-decorators/local-v.ts`
8. `javascript/packages/orchestrator/src/chain-decorators/mainnet-local-v.ts`
9. `javascript/packages/orchestrator/src/chain-decorators/oak.ts`
10. `javascript/packages/orchestrator/src/chain-decorators/mangata.ts`
11. `javascript/packages/orchestrator/src/chain-decorators/generic-evm.ts`

---

## prepare-state-for-zombienet.js Changes

**File:** `HydraDX-node/launch-configs/fork/prepare-state-for-zombienet.js`

Uses the same streaming libraries for consistency:

```javascript
const {parser} = require('stream-json');
const Assembler = require('stream-json/Assembler');
const {JsonStreamStringify} = require('json-stream-stringify');

// Enable BigInt JSON serialization (needed for @polkadot/types compatibility)
BigInt.prototype.toJSON = function () {
    return Number(this);
};

// Helper function to parse large JSON files using streaming
function parseJsonStream(filePath) {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(filePath);
        const jsonParser = parser();
        const assembler = Assembler.connectTo(jsonParser);

        assembler.on('done', asm => resolve(asm.current));
        jsonParser.on('error', reject);
        readStream.on('error', reject);

        readStream.pipe(jsonParser);
    });
}

// Helper function to write large JSON files using streaming
function writeJsonStream(filePath, data) {
    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(filePath);
        const jsonStream = new JsonStreamStringify(data);

        jsonStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);

        jsonStream.pipe(writeStream);
    });
}
```

**Package.json dependencies:**
```json
"stream-json": "^1.8.0",
"json-stream-stringify": "^3.1.6"
```

**Note:** The prepare script uses `BigInt.prototype.toJSON` for compatibility with `@polkadot/types` library which creates BigInt values when decoding SCALE data.
