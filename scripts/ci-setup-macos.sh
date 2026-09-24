#!/usr/bin/env bash
#
# Provisions a self-hosted macOS CI runner for dtf.
#
# Run ONCE on the runner machine, as the user the runner logs in as, with sudo
# available. It is idempotent.
#
#   sudo ./scripts/ci-setup-macos.sh --app-bundle-id com.example.app
#
# What this cannot do, and why: macOS will not let a script grant itself
# Accessibility while System Integrity Protection is on. TCC's system database is
# SIP-protected and only tccd may write to it, and the consent dialogs reject
# synthetic clicks specifically so that automation cannot click "Allow" for the
# user. There are exactly two supported ways around it on a CI box:
#
#   1. Disable SIP on the runner (fine for a dedicated VM) and let this script
#      write the grants directly. That is what this script does.
#   2. Enrol the runner in MDM and push a PPPC configuration profile. Better for
#      a fleet, and the only option if SIP must stay on. See docs/CI.md.
#
set -euo pipefail

APP_BUNDLE_ID=""
TEST_RUNNER_BINARY="/bin/bash"   # the process that will run `dtf`

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-bundle-id) APP_BUNDLE_ID="$2"; shift 2 ;;
    --runner-binary) TEST_RUNNER_BINARY="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }

# ── 1. Preconditions ─────────────────────────────────────────────────────────

say "Checking the session"

if [[ "$(uname)" != "Darwin" ]]; then bad "not macOS"; exit 1; fi

# A GUI ("Aqua") session is non-negotiable. A runner installed as a LaunchDaemon
# has no window server connection: the accessibility tree is empty, screenshots
# come out black, and every test fails for reasons that look like bugs in your
# app. Install the runner as a LaunchAgent under an auto-logged-in user instead.
if launchctl managername 2>/dev/null | grep -qi aqua; then
  ok "running in a GUI (Aqua) session"
else
  bad "no GUI session — the runner is a daemon, not a user agent."
  echo "     Install the runner as a LaunchAgent under an auto-login user."
  echo "     See docs/CI.md → 'The runner must be a LaunchAgent'."
  exit 1
fi

SIP_STATUS="$(csrutil status 2>/dev/null || echo unknown)"
if grep -qi "disabled" <<<"$SIP_STATUS"; then
  ok "SIP is disabled — TCC grants can be written directly"
  SIP_OFF=1
else
  warn "SIP is enabled — this script cannot write TCC grants."
  echo "     Either disable SIP on this runner (recovery mode: csrutil disable),"
  echo "     or push a PPPC profile via MDM. See docs/CI.md."
  SIP_OFF=0
fi

# ── 2. Keep the screen awake and unlocked ────────────────────────────────────

say "Display and idle settings"

# A locked screen or an active screen saver detaches the window server from the
# session; the symptoms are identical to a missing permission, which makes this
# a genuinely expensive thing to get wrong.
defaults -currentHost write com.apple.screensaver idleTime -int 0
sudo systemsetup -setcomputersleep Never >/dev/null 2>&1 || true
sudo systemsetup -setdisplaysleep Never >/dev/null 2>&1 || true
ok "screen saver and sleep disabled"

if ! pgrep -x caffeinate >/dev/null; then
  nohup caffeinate -dimsu >/dev/null 2>&1 &
  ok "caffeinate started"
else
  ok "caffeinate already running"
fi

# Focus modes silently suppress notification banners. Every notification
# assertion then fails with no visible cause.
defaults -currentHost write com.apple.notificationcenterui doNotDisturb -bool false 2>/dev/null || true
ok "Do Not Disturb disabled"

# ── 3. Pre-grant TCC ─────────────────────────────────────────────────────────

say "Privacy permissions"

TCC_SYSTEM="/Library/Application Support/com.apple.TCC/TCC.db"

grant() {
  local service="$1" client="$2" client_type="$3"   # client_type: 0 = bundle id, 1 = absolute path
  sudo /usr/bin/python3 - "$TCC_SYSTEM" "$service" "$client" "$client_type" <<'PY'
import sqlite3, sys, time

db, service, client, client_type = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
con = sqlite3.connect(db)

# The `access` table has gained columns in most macOS releases, so build the row
# from the live schema rather than hardcoding a column count that breaks on the
# next upgrade.
cols = [r[1] for r in con.execute("PRAGMA table_info(access)")]
now = int(time.time())
values = {
    "service": service,
    "client": client,
    "client_type": client_type,
    "auth_value": 2,          # 2 = allowed
    "auth_reason": 4,         # 4 = set by the system administrator
    "auth_version": 1,
    "flags": 0,
    "last_modified": now,
    "policy_id": None,
    "indirect_object_identifier_type": 0,
    "indirect_object_identifier": "UNUSED",
    "indirect_object_code_identity": None,
    "csreq": None,
    "pid": None,
    "pid_version": None,
    "boot_uuid": "UNUSED",
    "last_reminded": now,
}
row = [values.get(c) for c in cols]
placeholders = ",".join("?" * len(cols))
con.execute(f"INSERT OR REPLACE INTO access ({','.join(cols)}) VALUES ({placeholders})", row)
con.commit()
print(f"granted {service} -> {client}")
PY
}

if [[ "$SIP_OFF" == "1" ]]; then
  # The test runner needs these. Accessibility is the only mandatory one;
  # the rest unlock specific features and are listed with what they buy.
  grant kTCCServiceAccessibility     "$TEST_RUNNER_BINARY" 1   # required: drive the OS
  grant kTCCServiceScreenCapture     "$TEST_RUNNER_BINARY" 1   # screenshots on failure
  grant kTCCServiceAppleEvents       "$TEST_RUNNER_BINARY" 1   # read browser URLs (OAuth handoff)
  grant kTCCServiceSystemPolicyAllFiles "$TEST_RUNNER_BINARY" 1 # read TCC.db for permission status
  ok "runner permissions granted to $TEST_RUNNER_BINARY"

  if [[ -n "$APP_BUNDLE_ID" ]]; then
    # Whatever the app under test needs, so it never blocks on a consent dialog
    # that nothing can click. Add or remove to match your app.
    grant kTCCServiceScreenCapture "$APP_BUNDLE_ID" 0
    grant kTCCServiceMicrophone    "$APP_BUNDLE_ID" 0
    ok "app permissions granted to $APP_BUNDLE_ID"
  else
    warn "no --app-bundle-id given; the app under test was not pre-granted anything"
  fi

  # tccd caches aggressively; without this the grants appear only after a reboot.
  sudo killall tccd 2>/dev/null || true
  ok "tccd restarted to pick up the new grants"
else
  warn "skipped TCC grants (SIP is on)"
fi

# ── 4. Verify ────────────────────────────────────────────────────────────────

say "Verifying"
if command -v node >/dev/null; then
  node "$(dirname "$0")/../src/cli.ts" doctor || true
else
  warn "node not found — run 'npx dtf doctor' manually once Node is installed"
fi

say "Done"
echo "  If doctor still reports a missing Accessibility grant, reboot once —"
echo "  tccd occasionally holds the old decision until the next login."
