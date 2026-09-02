#!/bin/bash
set -euo pipefail

MODE=""
OUTPUT=""
APPROVED_HASH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --approved-report-sha256) APPROVED_HASH="${2:-}"; shift 2 ;;
    *) echo "UNKNOWN_ARGUMENT" >&2; exit 2 ;;
  esac
done

if [[ -z "$MODE" ]]; then echo "MODE_REQUIRED" >&2; exit 2; fi
if [[ "$MODE" != "observe" && "$MODE" != "supervised-send" && "$MODE" != "live" ]]; then
  echo "INVALID_MODE" >&2; exit 2
fi
if [[ -z "$OUTPUT" ]]; then echo "OUTPUT_REQUIRED" >&2; exit 2; fi
if [[ "$MODE" != "observe" && ! "$APPROVED_HASH" =~ ^[a-f0-9]{64}$ ]]; then
  echo "APPROVED_REPORT_HASH_REQUIRED" >&2; exit 2
fi

BIN_ROOT="${HOME}/Desktop/聊天助手/bin"
mkdir -p "$(dirname "$OUTPUT")"
umask 077
cat > "$OUTPUT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.wechat-ai-assistant-public.heartbeat</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/perl</string>
    <string>-e</string><string>\$SIG{ALRM}=sub{exit 124}; alarm 60; exec @ARGV</string>
    <string>/usr/bin/env</string><string>node</string>
    <string>${BIN_ROOT}/dist/src/cli.js</string>
    <string>run-once</string><string>--mode</string><string>${MODE}</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
PLIST
chmod 600 "$OUTPUT"
echo "template:$OUTPUT"
