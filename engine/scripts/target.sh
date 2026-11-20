# Sourced by the build scripts. Sets PLATFORM, ARCH, TARGET and EXE using
# Node's naming (darwin/linux/win32, arm64/x64) so paths match electron-builder.
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=win32 ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
TARGET="$PLATFORM-$ARCH"
EXE=""
if [[ "$PLATFORM" == "win32" ]]; then EXE=".exe"; fi
export PLATFORM ARCH TARGET EXE
