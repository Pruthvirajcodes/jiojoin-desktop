#!/usr/bin/env bash
# Builds the engine's native dependencies as static libraries:
# opencore-amr (AMR-NB codec, AMR-WB decoder), vo-amrwbenc (AMR-WB encoder),
# OpenSSL 3.5 LTS (macOS and Linux) and PJSIP 2.17 with OpenSSL TLS.
# Output: engine/.deps/<target>/prefix
#
# OpenSSL is built from source rather than taken from the system so the
# engine runs beyond the machine that built it: on macOS, Homebrew's archives
# target the host's macOS version; on Linux, linking it statically keeps the
# AppImage independent of the distribution's libssl.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=engine/scripts/target.sh
source "$ENGINE_DIR/scripts/target.sh"

CACHE="$ENGINE_DIR/.cache"
DEPS="$ENGINE_DIR/.deps/$TARGET"
PREFIX="$DEPS/prefix"
SRC="$DEPS/src"
STAMP="$PREFIX/.built-v2"

if [[ -f "$STAMP" && "${1:-}" != "--force" ]]; then
  echo "deps: already built for $TARGET ($PREFIX)"
  exit 0
fi

PJ_VER=2.17
AMR_VER=0.1.6
WBENC_VER=0.1.3
SSL_VER=3.5.9
PJ_URL="https://github.com/pjsip/pjproject/archive/refs/tags/$PJ_VER.tar.gz"
AMR_URL="https://downloads.sourceforge.net/project/opencore-amr/opencore-amr/opencore-amr-$AMR_VER.tar.gz"
WBENC_URL="https://downloads.sourceforge.net/project/opencore-amr/vo-amrwbenc/vo-amrwbenc-$WBENC_VER.tar.gz"
SSL_URL="https://github.com/openssl/openssl/releases/download/openssl-$SSL_VER/openssl-$SSL_VER.tar.gz"
PJ_SHA=065fe06c06788d97c35f563796d59f00ce52fe9558a52d7b490a042a966facce
AMR_SHA=483eb4061088e2b34b358e47540b5d495a96cd468e361050fae615b1809dc4a1
WBENC_SHA=5652b391e0f0e296417b841b02987d3fd33e6c0af342c69542cbb016a71d9d4e
SSL_SHA=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() { # url file sha
  local url=$1 file=$2 sha=$3
  mkdir -p "$CACHE"
  if [[ ! -f "$CACHE/$file" ]]; then
    echo "deps: downloading $file"
    curl -fsSL --retry 3 -o "$CACHE/$file.part" "$url"
    mv "$CACHE/$file.part" "$CACHE/$file"
  fi
  local got; got="$(sha256 "$CACHE/$file")"
  if [[ "$got" != "$sha" ]]; then
    echo "deps: checksum mismatch for $file (got $got)" >&2
    exit 1
  fi
}

fetch "$PJ_URL" "pjproject-$PJ_VER.tar.gz" "$PJ_SHA"
fetch "$AMR_URL" "opencore-amr-$AMR_VER.tar.gz" "$AMR_SHA"
fetch "$WBENC_URL" "vo-amrwbenc-$WBENC_VER.tar.gz" "$WBENC_SHA"
if [[ "$PLATFORM" != "win32" ]]; then fetch "$SSL_URL" "openssl-$SSL_VER.tar.gz" "$SSL_SHA"; fi

rm -rf "$SRC" "$PREFIX"
mkdir -p "$SRC" "$PREFIX"

JOBS="${JOBS:-2}"
export CFLAGS="${CFLAGS:-} -O2 -DNDEBUG"
if [[ "$PLATFORM" == "darwin" ]]; then
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
fi

echo "deps: building opencore-amr $AMR_VER"
tar -xzf "$CACHE/opencore-amr-$AMR_VER.tar.gz" -C "$SRC"
( cd "$SRC/opencore-amr-$AMR_VER" \
  && ./configure --prefix="$PREFIX" --disable-shared --enable-static --with-pic >/dev/null \
  && make -j"$JOBS" >/dev/null && make install >/dev/null )

echo "deps: building vo-amrwbenc $WBENC_VER"
tar -xzf "$CACHE/vo-amrwbenc-$WBENC_VER.tar.gz" -C "$SRC"
( cd "$SRC/vo-amrwbenc-$WBENC_VER" \
  && ./configure --prefix="$PREFIX" --disable-shared --enable-static --with-pic >/dev/null \
  && make -j"$JOBS" >/dev/null && make install >/dev/null )

# OpenSSL, always linked statically so the engine is self-contained. Windows
# uses MSYS2's static archives; macOS and Linux build the pinned release.
SSL_ARGS=()
case "$PLATFORM-$ARCH" in
  darwin-arm64) SSL_TARGET=darwin64-arm64-cc ;;
  darwin-x64) SSL_TARGET=darwin64-x86_64-cc ;;
  linux-x64) SSL_TARGET=linux-x86_64 ;;
  linux-arm64) SSL_TARGET=linux-aarch64 ;;
  *) SSL_TARGET="" ;;
esac
if [[ "$PLATFORM" == "win32" ]]; then
  SSL_ARGS=(--with-ssl="${OPENSSL_ROOT:-${MINGW_PREFIX:-/mingw64}}")
  export LDFLAGS="${LDFLAGS:-} -static"
else
  echo "deps: building OpenSSL $SSL_VER"
  tar -xzf "$CACHE/openssl-$SSL_VER.tar.gz" -C "$SRC"
  ( cd "$SRC/openssl-$SSL_VER" \
    && ./Configure "$SSL_TARGET" --prefix="$PREFIX/openssl" --libdir=lib \
         no-shared no-tests no-docs no-apps no-legacy > "$DEPS/openssl-configure.log" 2>&1 \
    && make -j"$JOBS" build_libs > "$DEPS/openssl-build.log" 2>&1 \
    && make install_dev >> "$DEPS/openssl-build.log" 2>&1 ) \
    || { tail -40 "$DEPS/openssl-build.log" "$DEPS/openssl-configure.log" >&2 2>/dev/null; exit 1; }
  SSL_ARGS=(--with-ssl="$PREFIX/openssl")
  if [[ "$PLATFORM" == "darwin" ]]; then SSL_ARGS+=(--disable-darwin-ssl); fi
fi

echo "deps: building pjproject $PJ_VER"
tar -xzf "$CACHE/pjproject-$PJ_VER.tar.gz" -C "$SRC"
PJ="$SRC/pjproject-$PJ_VER"
patch -d "$PJ" -p1 < "$ENGINE_DIR/patches/pjproject-$PJ_VER-jio.patch"
cp "$ENGINE_DIR/src/config_site.h" "$PJ/pjlib/include/pj/config_site.h"
( cd "$PJ" \
  && ./configure --prefix="$PREFIX" --disable-shared \
       --disable-video --disable-libyuv --disable-libwebrtc \
       --disable-ffmpeg --disable-sdl --disable-openh264 --disable-vpx --disable-v4l2 \
       --disable-opus --disable-bcg729 --disable-silk --disable-lyra --disable-upnp \
       --disable-pjsua2 --disable-g7221-codec --disable-ilbc-codec --disable-gsm-codec \
       --disable-l16-codec --disable-g722-codec \
       --with-opencore-amr="$PREFIX" --with-opencore-amrwbenc="$PREFIX" \
       "${SSL_ARGS[@]}" > "$DEPS/pjproject-configure.log" 2>&1 \
  || { tail -40 "$DEPS/pjproject-configure.log" >&2; exit 1; } )

grep -q 'PJMEDIA_HAS_OPENCORE_AMRNB_CODEC *1' "$PJ/pjmedia/include/pjmedia-codec/config_auto.h" \
  || { echo "deps: PJSIP configure did not enable AMR-NB" >&2; exit 1; }
grep -q 'PJMEDIA_HAS_OPENCORE_AMRWB_CODEC *1' "$PJ/pjmedia/include/pjmedia-codec/config_auto.h" \
  || { echo "deps: PJSIP configure did not enable AMR-WB" >&2; exit 1; }
grep -q 'PJ_HAS_SSL_SOCK *1' "$PJ/pjlib/include/pj/compat/os_auto.h" \
  || { echo "deps: PJSIP configure did not enable TLS" >&2; exit 1; }

( cd "$PJ" && make dep > "$DEPS/pjproject-build.log" 2>&1 \
  && make -j"$JOBS" lib >> "$DEPS/pjproject-build.log" 2>&1 \
  && make install >> "$DEPS/pjproject-build.log" 2>&1 ) \
  || { tail -60 "$DEPS/pjproject-build.log" >&2; exit 1; }

touch "$STAMP"
echo "deps: done → $PREFIX"
