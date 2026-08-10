#!/usr/bin/env bash
# Register steam-client:// deeplink handler for the LINUX DEV workflow.
#
# This creates ~/.local/share/applications/steam-client-dev.desktop, which
# invokes `pnpm dev` in the repo with the URL appended. Electron's single-
# instance lock forwards the URL to the already-running dev instance via
# the `second-instance` event.
#
# For dev testing, you can also just use the login form in the app UI and
# skip this entirely.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/steam-client-dev.desktop"
LAUNCH_SCRIPT="$REPO_ROOT/scripts/dev-launch.sh"

mkdir -p "$DESKTOP_DIR"

# Launcher wrapper: always routes the URL through `electron .` so it hits the
# single-instance lock of the already-running electron-vite dev instance. If
# no dev instance is running, it starts one with the URL.
cat > "$LAUNCH_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$REPO_ROOT"
if pgrep -f "apps/desktop.*electron-vite" >/dev/null 2>&1; then
  # Dev instance is running — spawn a short-lived electron that gets swallowed
  # by the single-instance lock and forwards the URL via second-instance.
  exec pnpm --filter=@steam-client/desktop exec electron \
    "apps/desktop/out/main/index.js" "\$@" || true
else
  echo "[dev-launch] no running desktop instance; starting pnpm dev with URL=\$*"
  exec pnpm --filter=@steam-client/desktop dev -- "\$@"
fi
EOF
chmod +x "$LAUNCH_SCRIPT"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Steam Client (dev)
Comment=Development build of steam-client (handles steam-client:// deeplink)
Exec=$LAUNCH_SCRIPT %U
Terminal=true
Categories=Development;
MimeType=x-scheme-handler/steam-client;
NoDisplay=false
EOF

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
xdg-mime default steam-client-dev.desktop x-scheme-handler/steam-client

echo "registered: $DESKTOP_FILE"
echo "handler:    $(xdg-mime query default x-scheme-handler/steam-client)"
echo
echo "Test (make sure 'pnpm dev' is already running in another terminal):"
echo "  PASS_B64=\$(printf 'YOUR_PASSWORD' | base64 -w0 | tr '+/' '-_' | tr -d '=')"
echo "  xdg-open \"steam-client://login?username=USER&password=\$PASS_B64\""
