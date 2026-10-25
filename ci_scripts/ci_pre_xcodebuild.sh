#!/bin/sh
set -eu

repository_root="$(cd "$(dirname "$0")/.." && pwd)"

# A test-without-building step gets ci_scripts and the test products only, not apps/: nothing to number there.
if [ -n "${CI_BUILD_NUMBER:-}" ] && [ -d "$repository_root/apps/ios-app" ]; then
  (
    cd "$repository_root/apps/ios-app"
    xcrun agvtool new-version -all "$CI_BUILD_NUMBER"
  )
fi

if [ "${CI_XCODEBUILD_ACTION:-}" = "archive" ]; then
  swift test --package-path "$repository_root/apps/ios"
fi
