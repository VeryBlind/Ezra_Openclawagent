!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  OpenClaw Agent — One-line installer
#  Usage: curl -fsSL https://raw.githubusercontent.com/VeryBlind/Ezra_Openclawagent/main/install.sh | bash -s banker
#  Professions: banker | landlord | lawyer
# ═══════════════════════════════════════════════════════════════
 
set -e
 
PROFESSION="${1:-}"
BASE_URL="https://raw.githubusercontent.com/VeryBlind/Ezra_Openclawagent/main"
APP_DIR="$HOME/OpenClaw"
 
# ── Validate profession ──────────────────────────────────────────
if [[ "$PROFESSION" != "banker" && "$PROFESSION" != "landlord" && "$PROFESSION" != "lawyer" ]]; then
  echo ""
  echo "  Usage: curl -fsSL $BASE_URL/install.sh | bash -s [profession]"
  echo "  Professions: banker | landlord | lawyer"
  echo ""
  exit 1
fi
 
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   OpenClaw Agent · Installer             ║"
echo "  ║   Profession: $PROFESSION$(printf '%*s' $((22-${#PROFESSION})) '')║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
 
# ── Check Node.js ────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  Install it from https://nodejs.org (LTS) then re-run this command."
  exit 1
fi
 
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "  ERROR: Node.js 18+ required. Current: $(node -v)"
  echo "  Update at https://nodejs.org"
  exit 1
fi
echo "  [1/6] Node.js $(node -v) ✓"
 
# ── Create directories ───────────────────────────────────────────
mkdir -p "$APP_DIR/server" "$APP_DIR/public"
echo "  [2/6] Created $APP_DIR"
 
# ── Download files ───────────────────────────────────────────────
echo "  [3/6] Downloading files..."
curl -fsSL "$BASE_URL/server/index.js"    -o "$APP_DIR/server/index.js"
curl -fsSL "$BASE_URL/public/index.html"  -o "$APP_DIR/public/index.html"
curl -fsSL "$BASE_URL/package.json"       -o "$APP_DIR/package.json"
 
# ── Write config ─────────────────────────────────────────────────
cat > "$APP_DIR/config.json" << CONFIG
{
  "profession": "$PROFESSION",
  "anthropicApiKey": "REPLACE_ME",
  "googleClientId": "REPLACE_ME",
  "googleClientSecret": "REPLACE_ME"
}
CONFIG
echo "  [4/6] Config written (add API keys later)"
 
# ── Install dependencies ─────────────────────────────────────────
echo "  [5/6] Installing dependencies..."
cd "$APP_DIR" && npm install --silent
echo "        Done."
 
# ── Write launcher + stop scripts ───────────────────────────────
cat > "$APP_DIR/launch.sh" << 'LAUNCHER'
#!/bin/bash
cd "$HOME/OpenClaw"
node server/index.js &
echo $! > "$HOME/OpenClaw/.pid"
sleep 3
open -a "Google Chrome" --args --start-fullscreen "http://localhost:3747" 2>/dev/null \
  || open "http://localhost:3747"
LAUNCHER
chmod +x "$APP_DIR/launch.sh"
 
cat > "$APP_DIR/stop.sh" << 'STOP'
#!/bin/bash
[ -f "$HOME/OpenClaw/.pid" ] && kill $(cat "$HOME/OpenClaw/.pid") 2>/dev/null \
  && rm "$HOME/OpenClaw/.pid" && echo "OpenClaw stopped."
STOP
chmod +x "$APP_DIR/stop.sh"
 
# ── Register LaunchAgent (auto-start on boot) ────────────────────
mkdir -p "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/com.openclaw.agent.plist"
 
cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${APP_DIR}/launch.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${APP_DIR}/server.log</string>
  <key>StandardErrorPath</key><string>${APP_DIR}/error.log</string>
</dict>
</plist>
PLIST
 
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "  [6/6] Auto-launch on boot registered ✓"
 
# ── Name the machine ─────────────────────────────────────────────
sudo scutil --set ComputerName "OpenClaw-$PROFESSION" 2>/dev/null || true
 
# ── Done ─────────────────────────────────────────────────────────
echo ""
echo "  ✓ OpenClaw installed for: $PROFESSION"
echo ""
echo "  ─────────────────────────────────────────────────────────"
echo "  Next steps:"
echo ""
echo "  1. Add your API keys:"
echo "     nano $APP_DIR/config.json"
echo ""
echo "  2. Launch the agent:"
echo "     bash $APP_DIR/launch.sh"
echo ""
echo "  3. Connect Google account:"
echo "     Click 'Google: click to connect' in the app header"
echo "     Sign in with the client's Google account"
echo ""
echo "  The agent will auto-launch on every reboot from now on."
echo "  ─────────────────────────────────────────────────────────"
echo ""

