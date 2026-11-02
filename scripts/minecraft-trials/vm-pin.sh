#!/bin/bash
# usage: vm-pin.sh <body|head> <branch|sha>      (on the VM)   prints the pin directory ~/s4-pins/<kind>-<sha7>
# The tree of a branch (fetched from origin) or a commit, for the lab runs (run-hunt-lab.sh, s4-section-probe.sh take a directory holding backend/{src,scripts,package.json,...}).
# Only a `git fetch` touches the production checkouts (~/Shannon, ~/shannon-ios); nothing of their files is written.
set -eu
KIND=${1:?body|head}; REF=${2:?branch or sha}
case "$KIND" in
  body) REPO=$HOME/Shannon; PATHS="backend/src backend/scripts backend/package.json backend/tsconfig.json package.json backend/saves/minecraft/structures"; CHECK=backend ;;
  head) REPO=$HOME/shannon-ios; PATHS=""; CHECK=services ;;
  *) echo "usage: vm-pin.sh <body|head> <branch|sha>" >&2; exit 2 ;;
esac
if [[ "$REF" =~ ^[0-9a-f]{7,40}$ ]]; then
  git -C "$REPO" rev-parse --verify -q "$REF^{commit}" >/dev/null || git -C "$REPO" fetch -q origin
  SHA=$(git -C "$REPO" rev-parse "$REF^{commit}")
else
  git -C "$REPO" fetch -q origin "$REF"; SHA=$(git -C "$REPO" rev-parse FETCH_HEAD)
fi
PIN=$HOME/s4-pins/$KIND-${SHA:0:7}
if [ ! -d "$PIN/$CHECK" ]; then
  rm -rf "$PIN"; mkdir -p "$PIN"
  # shellcheck disable=SC2086
  git -C "$REPO" archive "$SHA" $PATHS | tar -x -m -C "$PIN"
fi
echo "$PIN"
