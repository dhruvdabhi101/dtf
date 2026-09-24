#!/usr/bin/env bash
# Builds the macOS native driver. Requires the Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O \
  -framework ApplicationServices -framework AppKit -framework CoreGraphics \
  -o bin/dtfd-macos \
  Sources/AX.swift Sources/Selector.swift Sources/Input.swift Sources/Ops.swift Sources/Recorder.swift Sources/main.swift
echo "built native/macos/bin/dtfd-macos"
