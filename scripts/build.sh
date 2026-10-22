#!/usr/bin/env bash
# Builds the Rowlit macOS app: engine (self-contained single file, per arch) + UI + Electron DMG/ZIP.
# macOS counterpart of scripts/build.ps1 (DMGs can only be built on a Mac; CI uses macos-latest).
#
# Version comes from version.json and is injected without editing package files:
#   engine   -> dotnet publish -p:Version=<v>
#   ui       -> VITE_APP_VERSION=<v>
#   desktop  -> electron-builder -c.extraMetadata.version=<v>
# Output: desktop/dist/Rowlit-<version>-mac-<arm64|x64>.dmg and .zip
#
# Usage:
#   bash scripts/build.sh                    # everything, arm64 + x64
#   bash scripts/build.sh --arch arm64       # one architecture only (faster)
#   bash scripts/build.sh --skip-installer   # engine publish + UI build + desktop compile, no electron-builder
#   bash scripts/build.sh --engine-only      # just dotnet publish into engine/publish/osx-<arch>
#   bash scripts/build.sh --dir              # unpacked app in desktop/dist/mac-arm64/Rowlit.app (no DMG)
#   bash scripts/build.sh --skip-engine --skip-ui
#
# Signing (see README "Install on Windows / macOS"):
#   default                      ad-hoc signature (identity "-"); Gatekeeper asks users to confirm the first launch
#   CSC_LINK + CSC_KEY_PASSWORD  Developer ID Application certificate (.p12, path or base64), or CSC_NAME for a
#                                certificate already in the keychain
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER)
#                                notarize and staple (only together with a Developer ID certificate)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_ENGINE=0 SKIP_UI=0 SKIP_INSTALLER=0 ENGINE_ONLY=0 DIR=0 VERIFY=1
CONFIGURATION=Release
ARCHES=(arm64 x64)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-engine) SKIP_ENGINE=1 ;;
    --skip-ui) SKIP_UI=1 ;;
    --skip-installer) SKIP_INSTALLER=1 ;;
    --engine-only) ENGINE_ONLY=1 ;;
    --dir) DIR=1 ;;
    --no-verify) VERIFY=0 ;;
    --configuration) CONFIGURATION="$2"; shift ;;
    --arch)
      case "$2" in
        arm64|x64) ARCHES=("$2") ;;
        both|all) ARCHES=(arm64 x64) ;;
        *) echo "--arch must be arm64, x64 or both" >&2; exit 2 ;;
      esac
      shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

START=$(date +%s)
step() { printf '\033[36m==> [%ss] %s\033[0m\n' "$(( $(date +%s) - START ))" "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || [[ $SKIP_INSTALLER == 1 || $ENGINE_ONLY == 1 ]] || \
  die "DMGs can only be built on macOS (use --engine-only or --skip-installer elsewhere)."
command -v node >/dev/null || die "Node.js 24 is required (https://nodejs.org)."

VERSION="$(node -p "require('$ROOT/version.json').version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "version.json: invalid version '$VERSION'"

HOST_PROJECT="$ROOT/engine/src/DbStudio.Host/DbStudio.Host.csproj"
UI_DIR="$ROOT/ui"
DESKTOP_DIR="$ROOT/desktop"
export DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1

printf '\033[32mRowlit %s (%s, macOS %s)\033[0m\n' "$VERSION" "$CONFIGURATION" "${ARCHES[*]}"

ensure_node_modules() {
  local dir="$1"
  if [[ ! -d "$dir/node_modules" ]]; then
    if [[ -f "$dir/package-lock.json" ]]; then (cd "$dir" && npm ci --fetch-retries=5); else (cd "$dir" && npm install --fetch-retries=5); fi
  fi
}

# Starts a published engine and waits for its READY line: catches a missing runtime, a bad signature or
# entitlements (the kernel kills the process) before anything is packaged.
verify_engine() {
  local exe="$1" log data pid i
  log="$(mktemp -t dbstudio-engine-verify)"
  data="$(mktemp -d -t dbstudio-engine-data)"
  DBSTUDIO_DATA_DIR="$data" DBSTUDIO_SECRET_STORE=memory "$exe" --parent-pid $$ >"$log" 2>&1 &
  pid=$!
  for i in $(seq 1 60); do
    if grep -q '^DBSTUDIO_READY ' "$log"; then
      kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
      rm -rf "$data" "$log"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL "$pid" 2>/dev/null || true
  echo "---- engine output ($exe) ----" >&2; cat "$log" >&2
  rm -rf "$data" "$log"
  return 1
}

# 1. Engine: self-contained single-file apphost per architecture. Native libraries (libe_sqlite3.dylib) stay next
#    to it instead of being self-extracted at runtime, so electron-builder signs them with the app (hardened
#    runtime + library validation) and nothing unsigned is ever written to and loaded from a temp folder.
if [[ $SKIP_ENGINE == 0 ]]; then
  for arch in "${ARCHES[@]}"; do
    rid="osx-$arch"
    out="$ROOT/engine/publish/$rid"
    step "dotnet publish ($rid) -> $out"
    rm -rf "$out"
    dotnet publish "$HOST_PROJECT" -c "$CONFIGURATION" -r "$rid" --self-contained true -o "$out" \
      -p:PublishSingleFile=true \
      -p:IncludeNativeLibrariesForSelfExtract=false \
      -p:EnableCompressionInSingleFile=true \
      -p:DebugType=embedded \
      -p:Version="$VERSION" \
      -nologo
    # electron-builder and engine-process.ts expect Rowlit.Engine (the process name users see); dotnet publish writes
    # DbStudio.Engine (the assembly name) or, for an older Host project, DbStudio.Host. A single-file apphost can be renamed.
    for published in DbStudio.Engine DbStudio.Host; do
      if [[ ! -f "$out/Rowlit.Engine" && -f "$out/$published" ]]; then mv "$out/$published" "$out/Rowlit.Engine"; fi
    done
    [[ -f "$out/Rowlit.Engine" ]] || die "Engine executable not found in $out"
    chmod 755 "$out/Rowlit.Engine"
    rm -f "$out/web.config" "$out"/*.pdb
    step "Engine ($rid): $(du -h "$out/Rowlit.Engine" | cut -f1)"
    host_arch="$(uname -m)"; [[ "$host_arch" == "x86_64" ]] && host_arch=x64
    if [[ $VERIFY == 1 && "$(uname -s)" == "Darwin" && "$arch" == "$host_arch" ]]; then
      step "Engine ($rid): handshake check"
      verify_engine "$out/Rowlit.Engine" || die "The $rid engine did not report ready."
    fi
  done
fi
if [[ $ENGINE_ONLY == 1 ]]; then step "Done (engine only)"; exit 0; fi

# 2. UI
if [[ $SKIP_UI == 0 ]]; then
  step "UI: npm run build"
  ensure_node_modules "$UI_DIR"
  (cd "$UI_DIR" && VITE_APP_VERSION="$VERSION" npm run build)
  [[ -f "$UI_DIR/dist/index.html" ]] || die "ui/dist/index.html was not produced"
fi

# 3. Desktop: type-check + bundle main/preload, then package.
step "Desktop: npm run build"
ensure_node_modules "$DESKTOP_DIR"
(cd "$DESKTOP_DIR" && npm run build)

if [[ $SKIP_INSTALLER == 1 ]]; then step "Done (installer skipped)"; exit 0; fi

for arch in "${ARCHES[@]}"; do
  [[ -x "$ROOT/engine/publish/osx-$arch/Rowlit.Engine" ]] || die "Missing engine/publish/osx-$arch/Rowlit.Engine - run without --skip-engine first."
done
[[ -f "$UI_DIR/dist/index.html" ]] || die "Missing ui/dist/index.html - run without --skip-ui first."

# Signing mode.
SIGN_ARGS=()
# CI passes unset secrets as empty strings; treat those as absent.
[[ -n "${CSC_LINK:-}" ]] || unset CSC_LINK CSC_KEY_PASSWORD
[[ -n "${CSC_NAME:-}" ]] || unset CSC_NAME
for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  [[ -n "${!v:-}" ]] || unset "$v"
done
if [[ -n "${CSC_LINK:-}" || -n "${CSC_NAME:-}" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=true
  if [[ -n "${APPLE_ID:-}" || -n "${APPLE_API_KEY:-}" || -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    step "Signing with a Developer ID certificate; notarization enabled"
  else
    step "Signing with a Developer ID certificate; NOT notarized (set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)"
  fi
else
  step "Ad-hoc signing (no CSC_LINK/CSC_NAME): users confirm the first launch (README: Gatekeeper)"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  # Notarization needs a Developer ID signature; make sure electron-builder does not try.
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER \
        APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE
  SIGN_ARGS+=("-c.mac.identity=-")
fi

ARCH_ARGS=()
for arch in "${ARCHES[@]}"; do ARCH_ARGS+=("--$arch"); done
if [[ $DIR == 1 ]]; then TARGETS=(dir); else TARGETS=(dmg zip); fi

step "electron-builder (${TARGETS[*]}; ${ARCHES[*]})"
(cd "$DESKTOP_DIR" && ./node_modules/.bin/electron-builder --mac "${TARGETS[@]}" "${ARCH_ARGS[@]}" --publish never \
  "-c.extraMetadata.version=$VERSION" ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"})

# 4. Check what was produced: bundle signature (incl. the engine and its entitlements), artifacts.
for arch in "${ARCHES[@]}"; do
  app="$DESKTOP_DIR/dist/mac-$arch/Rowlit.app"
  # electron-builder names the x64 folder plain "mac".
  [[ -d "$app" || "$arch" != x64 ]] || app="$DESKTOP_DIR/dist/mac/Rowlit.app"
  [[ -d "$app" ]] || die "App bundle not found for $arch in desktop/dist"
  engine="$app/Contents/Resources/engine/Rowlit.Engine"
  [[ -x "$engine" ]] || die "$engine is missing or not executable"
  if [[ $VERIFY == 1 ]]; then
    step "codesign --verify ($arch)"
    codesign --verify --deep --strict "$app"
    codesign -d --entitlements - "$engine" 2>/dev/null | grep -q 'com.apple.security.cs.allow-jit' \
      || die "The engine in $app is not signed with the JIT entitlements"
  fi
  if [[ $DIR == 0 ]]; then
    for ext in dmg zip; do
      f="$DESKTOP_DIR/dist/Rowlit-$VERSION-mac-$arch.$ext"
      [[ -f "$f" ]] || die "Artifact not found: $f"
      step "Done: $f ($(du -h "$f" | cut -f1))"
    done
  else
    step "Done: $app"
  fi
done
