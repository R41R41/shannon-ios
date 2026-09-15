#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")" && pwd)"
exec "$repository_root/scripts/xcode.sh" open
