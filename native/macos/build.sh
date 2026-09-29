#!/usr/bin/env bash
# Builds the macOS native driver. Requires the Xcode Command Line Tools.
#
# Produces a universal (arm64 + x86_64) binary so the one built on the release
# runner works on both Apple Silicon and Intel CI machines, then ad-hoc signs it
# so Gatekeeper lets it run after being unpacked from the npm tarball.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin build
SOURCES=(Sources/AX.swift Sources/Selector.swift Sources/Input.swift Sources/Ops.swift Sources/Recorder.swift Sources/main.swift)
FRAMEWORKS=(-framework ApplicationServices -framework AppKit -framework CoreGraphics)
MIN_MACOS="${DTF_MIN_MACOS:-12.0}"

for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos$MIN_MACOS" "${FRAMEWORKS[@]}" -o "build/dtfd-macos-$arch" "${SOURCES[@]}"
done
lipo -create -output bin/dtfd-macos build/dtfd-macos-arm64 build/dtfd-macos-x86_64
codesign --force --sign - bin/dtfd-macos
rm -rf build
echo "built native/macos/bin/dtfd-macos ($(lipo -archs bin/dtfd-macos))"
