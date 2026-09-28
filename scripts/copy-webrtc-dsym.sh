#!/bin/sh

set -eu

# stasel/WebRTC started publishing matching symbols separately in M152. SwiftPM
# downloads only the XCFramework asset, so an Archive build must place the
# device dSYM in the archive explicitly for App Store Connect to receive it.
webrtc_version="152.0.0"
symbols_url="https://github.com/stasel/WebRTC/releases/download/152.0.0/WebRTC-M152-dSYM.zip"
symbols_sha256="7c99e7cc12b59e4db357581271b412e9ce031ce21a23590a909f7ae1f0b20f87"

if [ "${SHANNON_WEBRTC_DSYM_FORCE:-0}" != "1" ]; then
  if [ "${ACTION:-}" != "install" ] || [ "${PLATFORM_NAME:-}" != "iphoneos" ] || [ "${CONFIGURATION:-}" != "Release" ]; then
    exit 0
  fi
fi

framework_binary="${SHANNON_WEBRTC_FRAMEWORK_BINARY:-${TARGET_BUILD_DIR:?}/${FRAMEWORKS_FOLDER_PATH:?}/WebRTC.framework/WebRTC}"
output_directory="${SHANNON_WEBRTC_DSYM_OUTPUT_DIR:-${DWARF_DSYM_FOLDER_PATH:?}}"

if [ ! -f "$framework_binary" ]; then
  echo "error: WebRTC framework binary was not found at $framework_binary" >&2
  exit 1
fi

uuid_set() {
  /usr/bin/xcrun dwarfdump --uuid "$1" | \
    /usr/bin/sed -n 's/^UUID: \([^ ]*\).*/\1/p' | \
    /usr/bin/tr '[:lower:]' '[:upper:]' | \
    /usr/bin/sort -u
}

framework_uuids="$(uuid_set "$framework_binary")"
destination_dsym="$output_directory/WebRTC.framework.dSYM"
destination_dwarf="$destination_dsym/Contents/Resources/DWARF/WebRTC"
destination_info="$destination_dsym/Contents/Info.plist"
destination_relocations="$destination_dsym/Contents/Resources/Relocations/aarch64/WebRTC.yml"
if [ -f "$destination_dwarf" ] && [ -f "$destination_info" ] && [ -f "$destination_relocations" ]; then
  existing_uuids="$(uuid_set "$destination_dwarf")"
  if [ -n "$framework_uuids" ] && [ "$framework_uuids" = "$existing_uuids" ]; then
    echo "Reusing WebRTC.framework.dSYM for UUIDs: $framework_uuids"
    exit 0
  fi
  echo "error: Existing WebRTC dSYM does not match the framework; clean the build folder and retry" >&2
  exit 1
fi

work_directory="$(mktemp -d "${TEMP_DIR:-${TMPDIR:-/tmp}}/ShannonWebRTCSymbols.XXXXXX")"
cleanup() {
  rm -rf "$work_directory"
}
trap cleanup EXIT HUP INT TERM

checksum() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

symbols_archive="${SHANNON_WEBRTC_DSYM_ARCHIVE:-${CACHE_ROOT:?}/Shannon-WebRTC-M152-dSYM.zip}"
if [ -z "${SHANNON_WEBRTC_DSYM_ARCHIVE:-}" ]; then
  if [ ! -f "$symbols_archive" ] || [ "$(checksum "$symbols_archive")" != "$symbols_sha256" ]; then
    downloaded_archive="$work_directory/WebRTC-M152-dSYM.zip"
    echo "Downloading WebRTC ${webrtc_version} symbols for the archive"
    # Cloud can reset TLS while fetching this idempotent public asset. Retry all
    # transfer failures into a file, with bounded attempts, then verify as usual.
    /usr/bin/curl --fail --location --retry 3 --retry-all-errors \
      --connect-timeout 20 --max-time 120 --retry-max-time 180 --silent --show-error \
      --output "$downloaded_archive" "$symbols_url"
    actual_checksum="$(checksum "$downloaded_archive")"
    if [ "$actual_checksum" != "$symbols_sha256" ]; then
      echo "error: WebRTC dSYM checksum mismatch: expected $symbols_sha256, got $actual_checksum" >&2
      exit 1
    fi
    /bin/rm -f "$symbols_archive"
    /bin/mv "$downloaded_archive" "$symbols_archive"
  fi
fi

actual_checksum="$(checksum "$symbols_archive")"
if [ "$actual_checksum" != "$symbols_sha256" ]; then
  echo "error: WebRTC dSYM checksum mismatch: expected $symbols_sha256, got $actual_checksum" >&2
  exit 1
fi

extraction_directory="$work_directory/extracted"
/bin/mkdir -p "$extraction_directory"
/usr/bin/unzip -q "$symbols_archive" 'WebRTC-ios-arm64.dSYM/*' -d "$extraction_directory"

source_dsym="$extraction_directory/WebRTC-ios-arm64.dSYM"
source_dwarf="$source_dsym/Contents/Resources/DWARF/WebRTC"
source_info="$source_dsym/Contents/Info.plist"
source_relocations="$source_dsym/Contents/Resources/Relocations/aarch64/WebRTC.yml"
if [ ! -f "$source_dwarf" ] || [ ! -f "$source_info" ] || [ ! -f "$source_relocations" ]; then
  echo "error: WebRTC device dSYM was not found in the verified symbols archive" >&2
  exit 1
fi

symbol_uuids="$(uuid_set "$source_dwarf")"
if [ -z "$framework_uuids" ] || [ "$framework_uuids" != "$symbol_uuids" ]; then
  echo "error: WebRTC framework and dSYM UUIDs do not match" >&2
  echo "Framework UUIDs: $framework_uuids" >&2
  echo "dSYM UUIDs: $symbol_uuids" >&2
  exit 1
fi

# Xcode's user-script sandbox permits only the declared output files. Copy each
# dSYM payload directly instead of using ditto/mv, both of which create
# undeclared temporary or nested paths when Xcode pre-creates directory outputs.
/bin/mkdir -p "$(/usr/bin/dirname "$destination_dwarf")"
/bin/mkdir -p "$(/usr/bin/dirname "$destination_relocations")"
/bin/cp "$source_dwarf" "$destination_dwarf"
/bin/cp "$source_info" "$destination_info"
/bin/cp "$source_relocations" "$destination_relocations"

echo "Included WebRTC.framework.dSYM for UUIDs: $framework_uuids"
