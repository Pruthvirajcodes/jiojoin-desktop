#!/usr/bin/env bash
# Compiles the engine sidecar against the static deps from build-deps.sh.
# Output: engine/dist/<platform>-<arch>/jiojoin-engine[.exe]
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=engine/scripts/target.sh
source "$ENGINE_DIR/scripts/target.sh"

PREFIX="$ENGINE_DIR/.deps/$TARGET/prefix"
OUT_DIR="$ENGINE_DIR/dist/$TARGET"
OUT="$OUT_DIR/jiojoin-engine$EXE"

bash "$ENGINE_DIR/scripts/build-deps.sh"

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
CFLAGS_PJ="$(pkg-config --cflags libpjproject)"
LIBS_PJ="$(pkg-config --static --libs libpjproject)"

EXTRA_LDFLAGS=()
EXTRA_LIBS=()
case "$PLATFORM" in
  darwin)
    # Same floor as the dependencies, so the engine loads on older macOS.
    export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
    # Resolve -lssl/-lcrypto to the static archives built by build-deps.sh.
    EXTRA_LDFLAGS+=("-L$PREFIX/openssl/lib" -Wl,-dead_strip)
    ;;
  linux)
    EXTRA_LDFLAGS+=("-L$PREFIX/openssl/lib" -Wl,--gc-sections -Wl,--as-needed)
    ;;
  win32)
    EXTRA_LDFLAGS+=(-static -Wl,--gc-sections)
    # After PJSIP's libraries: what static libcrypto needs from Windows.
    EXTRA_LIBS+=(-lws2_32 -lcrypt32 -lbcrypt -lgdi32 -luser32 -ladvapi32)
    ;;
esac

mkdir -p "$OUT_DIR"
# shellcheck disable=SC2086
"${CC:-cc}" -std=gnu11 -O2 -DNDEBUG -Wall -Wextra -Wno-unused-parameter -Wno-unused-function \
  $CFLAGS_PJ "$ENGINE_DIR/src/engine.c" -o "$OUT" \
  "${EXTRA_LDFLAGS[@]}" $LIBS_PJ ${EXTRA_LIBS[@]+"${EXTRA_LIBS[@]}"}

if [[ "$PLATFORM" != "win32" ]]; then strip "$OUT" 2>/dev/null || true; fi
if [[ "$PLATFORM" == "darwin" ]]; then codesign --force --sign - "$OUT" 2>/dev/null || true; fi

echo "engine: built $OUT"
"$OUT" --version
