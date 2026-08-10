#!/usr/bin/env bash
#
# scripts/package-win.sh — cross-build Windows .zip from a Linux host.
#
# Why this exists:
#   electron-builder picks up better-sqlite3's native .node from
#   node_modules/. On a fresh Linux clone that .node is the Linux ELF
#   compiled by `electron-rebuild` (apps/desktop's postinstall). When
#   electron-builder packages the win32 zip it copies that Linux .node
#   verbatim, producing a zip that crashes on launch on Windows.
#
#   Setting npm_config_target_platform=win32 / target_arch=x64 makes
#   prebuild-install (better-sqlite3's install script) fetch the win32-x64
#   prebuild — but apps/desktop's postinstall then runs electron-rebuild
#   which calls prebuild-install AGAIN with platform=linux and clobbers
#   it. @electron/rebuild 4.x has no --platform flag, so we re-fetch the
#   win32 prebuild explicitly after install, and pass
#   --config.npmRebuild=false to electron-builder so it doesn't run its
#   own rebuild step (which would also clobber).
#
#   The win32-x64 prebuild from WiseLibs/better-sqlite3 is statically
#   linked, so end users need no MSVC runtime and no admin rights —
#   extract the zip and run.
#
# Flow:
#   1. Reinstall workspace forcing a win32-x64 native fetch (env vars).
#   2. Re-fetch win32-x64 prebuild via prebuild-install — overwrites the
#      linux-x64 binary that the postinstall electron-rebuild left.
#   3. Build the desktop bundle (electron-vite build).
#   4. Run electron-builder with npmRebuild=false so it doesn't clobber.
#   5. ALWAYS restore the Linux ABI of better-sqlite3 (trap), so the dev
#      loop (`pnpm dev`) still works after this script exits.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }

restore_linux_abi() {
  say "Restoring Linux ABI for better-sqlite3 (dev environment)"
  unset npm_config_target_platform npm_config_target_arch
  pnpm install --force
  pnpm --filter @steam-client/desktop exec electron-rebuild -f -w better-sqlite3
  ok "Linux ABI restored"
}
trap restore_linux_abi EXIT

say "Installing dependencies with win32-x64 native targets"
export npm_config_target_platform=win32
export npm_config_target_arch=x64
pnpm install --force

say "Re-fetching win32-x64 prebuild for better-sqlite3"
ELECTRON_VERSION="$(node -p "require('./apps/desktop/package.json').devDependencies.electron")"
ELECTRON_VERSION="${ELECTRON_VERSION#^}"
ELECTRON_VERSION="${ELECTRON_VERSION#~}"
BSQLITE_DIR="node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3"
( cd "${BSQLITE_DIR}" && \
    pnpm exec prebuild-install \
      --runtime=electron \
      --target="${ELECTRON_VERSION}" \
      --platform=win32 \
      --arch=x64 \
      --tag-prefix=v \
      --force )
file "${BSQLITE_DIR}/build/Release/better_sqlite3.node"

say "Building desktop bundle"
pnpm --filter @steam-client/desktop build

say "Running electron-builder for --win"
pnpm --filter @steam-client/desktop exec electron-builder \
  --win \
  --config electron-builder.yml \
  --config.npmRebuild=false

ok "Windows zip ready in apps/desktop/dist/"
