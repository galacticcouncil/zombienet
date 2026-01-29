#!/bin/bash
set -e

# Build zombienet binaries for all platforms
# - Linux binaries are built in Docker (ensures correct native modules)
# - macOS binaries are built natively on this Mac

echo "=========================================="
echo "Building zombienet-linux-x64 in Docker..."
echo "=========================================="

docker run --rm --platform linux/amd64 \
    -v "$(pwd)":/zombienet \
    -w /zombienet/javascript \
    node:18-bookworm \
    bash -c "
        set -e
        echo '=== Installing dependencies ==='
        npm install
        npm dedupe

        echo '=== Building TypeScript ==='
        npm run build

        echo '=== Packaging binary ==='
        npm run package:linux:x64

        echo '=== Testing binary ==='
        ./bins/zombienet-linux-x64 version

        echo '=== Done! Binary at javascript/bins/zombienet-linux-x64 ==='
    "

echo ""
echo "============================================"
echo "Building zombienet-linux-arm64 in Docker..."
echo "============================================"

docker run --rm --platform linux/arm64 \
    -v "$(pwd)":/zombienet \
    -w /zombienet/javascript \
    node:18-bookworm \
    bash -c "
        set -e
        echo '=== Installing dependencies ==='
        npm install
        npm dedupe

        echo '=== Building TypeScript ==='
        npm run build

        echo '=== Packaging binary ==='
        npm run package:linux:arm64

        echo '=== Testing binary ==='
        ./bins/zombienet-linux-arm64 version

        echo '=== Done! Binary at javascript/bins/zombienet-linux-arm64 ==='
    "

echo ""
echo "============================================"
echo "Building zombienet-macos-arm64 (native)..."
echo "============================================"

cd javascript
npm install
npm dedupe
npm run build
npm run package:macos:arm64
./bins/zombienet-macos-arm64 version
echo "=== Done! Binary at javascript/bins/zombienet-macos-arm64 ==="

echo ""
echo "==========================================="
echo "Building zombienet-macos-x64 (native)..."
echo "==========================================="

npm run package:macos:x64
echo "=== Done! Binary at javascript/bins/zombienet-macos-x64 ==="
cd ..

echo ""
echo "=========================================="
echo "Build complete!"
echo "=========================================="
echo ""
echo "Binaries created at:"
echo "  - $(pwd)/javascript/bins/zombienet-linux-x64"
echo "  - $(pwd)/javascript/bins/zombienet-linux-arm64"
echo "  - $(pwd)/javascript/bins/zombienet-macos-arm64"
echo "  - $(pwd)/javascript/bins/zombienet-macos-x64"
echo ""
echo "To upload to GitHub release:"
echo "  gh release upload v1.3.128-patch javascript/bins/zombienet-linux-x64 --clobber -R galacticcouncil/zombienet"
echo "  gh release upload v1.3.128-patch javascript/bins/zombienet-linux-arm64 --clobber -R galacticcouncil/zombienet"
echo "  gh release upload v1.3.128-patch javascript/bins/zombienet-macos-arm64 --clobber -R galacticcouncil/zombienet"
echo "  gh release upload v1.3.128-patch javascript/bins/zombienet-macos-x64 --clobber -R galacticcouncil/zombienet"
