#!/usr/bin/env bash
# Builds DTFFixture.app — the sample app the framework's own tests drive.
set -euo pipefail
cd "$(dirname "$0")"
APP="DTFFixture.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>DTFFixture</string>
  <key>CFBundleIdentifier</key><string>com.dtf.fixture</string>
  <key>CFBundleName</key><string>DTF Fixture</string>
  <key>CFBundleDisplayName</key><string>DTF Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>CFBundleURLName</key><string>DTF Fixture</string>
      <key>CFBundleURLSchemes</key><array><string>dtffixture</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

swiftc -O -framework Cocoa -framework UserNotifications \
  -o "$APP/Contents/MacOS/DTFFixture" main.swift

# UNUserNotificationCenter refuses to run in an unsigned bundle; an ad-hoc
# signature is enough for local testing.
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "warning: ad-hoc codesign failed; notifications may not post"
echo "built $(pwd)/$APP"
