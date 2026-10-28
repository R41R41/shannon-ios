#!/usr/bin/env bash
# Copies the body's REAL outputs of the "continue" contract into the head's fixtures, from one named revision of the body (contract chapter 9).
#
#   scripts/sync-body-produced.sh <body rev> [--body-repo <path>] [--head-repo <path>]
#
#   <body rev>     a git revision of the body (hex, 7 to 40 digits). A branch name is refused: the copy must name one commit.
#   --body-repo    the body's clone (default $BODY_REPO, else /mnt/c/Shannon/Shannon-continue as WSL sees it, /c/Shannon/Shannon-continue in Git Bash).
#   --head-repo    the head's clone to write into (default: the clone this script is in).
#
# Reads backend/contracts/continue/produced/*.json at <body rev> (git show: the working tree of the body is never read), and writes
#   <head>/services/api/tests/fixtures/continue/produced/*.json   and   .../produced/PRODUCED.json  ({bodyRev: the commit read, madeBy: the rev the files name, files: {name: sha256}})
# NOTHING IS COPIED unless every file passes (a produced file of another version is a fail, not a warning - chapter 9):
#   - the body has a produced/ directory at <body rev> with at least one .json file;
#   - each file says, in its "continueProduced" object, "bodyRev" (a git rev of the body, all files the same one): the body that made it. A file cannot
#     name the commit it is committed in, so "the same as <body rev>" means: that commit, or one whose code is the same - no difference under
#     CODE_PATHS (backend/src, backend/package.json) between it and <body rev>. Any other rev is a fail;
#   - a file made from a fixture says "inputFixture" (a path under tests/fixtures/continue/) and "inputSha256", and that sha256 is the one of the head's file.
# The files are read with grep, not a JSON parser (the PC's Git Bash has no node): inside a produced file the keys "bodyRev", "inputFixture" and
# "inputSha256" belong to "continueProduced" and must not be used by the payload. "script" and "bench" are for people.
# Needs: bash, git, sha256sum, grep, sed.
set -euo pipefail

die() { printf 'sync-body-produced: %s\n' "$*" >&2; exit 1; }
REV=""; BODY_REPO=${BODY_REPO:-}; HEAD_REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --body-repo) [ $# -ge 2 ] || die "--body-repo needs a path"; BODY_REPO=$2; shift 2;;
    --head-repo) [ $# -ge 2 ] || die "--head-repo needs a path"; HEAD_REPO=$2; shift 2;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}"; exit 0;;
    -*) die "unknown argument $1";;
    *) [ -z "$REV" ] || die "one revision only"; REV=$1; shift;;
  esac
done
[ -n "$REV" ] || die "usage: sync-body-produced.sh <body rev> [--body-repo <path>] [--head-repo <path>]"
[[ "$REV" =~ ^[0-9a-fA-F]{7,40}$ ]] || die "'$REV' is not a hex git revision (a branch or tag name is refused: name the commit)"
if [ -z "$BODY_REPO" ]; then if [ -d /mnt/c/Shannon ]; then BODY_REPO=/mnt/c/Shannon/Shannon-continue; else BODY_REPO=/c/Shannon/Shannon-continue; fi; fi
[ -n "$HEAD_REPO" ] || HEAD_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -e "$BODY_REPO/.git" ] || die "$BODY_REPO is not a git clone (pass --body-repo)"
FIX=services/api/tests/fixtures/continue
[ -d "$HEAD_REPO/$FIX" ] || die "$HEAD_REPO has no $FIX (pass --head-repo)"

# A worktree made on Windows has a .git FILE naming a Windows path: use the shared object store of its main repository directly (as local-gate.sh does).
gitdir_of() {
  if [ -d "$1/.git" ]; then printf '%s\n' "$1/.git"; return; fi
  local d; d=$(sed -n 's/^gitdir: //p' "$1/.git" | tr -d '\r')
  if [ -d /mnt/c ]; then d=$(printf '%s' "$d" | sed -E 's#^([A-Za-z]):/#/mnt/\L\1/#'); fi
  d=$(printf '%s' "$d" | sed -E 's#/worktrees/[^/]+$##')
  [ -d "$d" ] || die "cannot find the git directory of $1 ($d)"
  printf '%s\n' "$d"
}
BODY_GIT=$(gitdir_of "$BODY_REPO")
gitb() { git -c safe.directory='*' --git-dir="$BODY_GIT" "$@"; }

FULL=$(gitb rev-parse --verify --quiet "$REV^{commit}") || die "revision $REV is not in $BODY_REPO"
PRODUCED_DIR=backend/contracts/continue/produced
CODE_PATHS=(backend/src backend/package.json)   # what builds the body: a produced file is current while these are the same as at the rev named
MADEBY=""
mapfile -t PATHS < <(gitb ls-tree -r --name-only "$FULL" -- "$PRODUCED_DIR/")
[ "${#PATHS[@]}" -gt 0 ] || die "the body at $FULL has no $PRODUCED_DIR/ (continue-produce.ts has not been run, or not committed): nothing to copy"

DEST="$HEAD_REPO/$FIX/produced"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/sync-produced-XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/new"
field() {   # field <file> <key>: the first string value of "key" in the file
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" | head -1 | sed -E 's/^[^:]*:[[:space:]]*"(.*)"$/\1/'
}
for path in "${PATHS[@]}"; do
  name=${path#"$PRODUCED_DIR/"}
  [[ "$name" =~ ^[A-Za-z0-9._-]+\.json$ ]] || die "unexpected file $path (only flat .json files, plain names, belong in produced/)"
  gitb show "$FULL:$path" > "$STAGE/new/$name"
  made=$(field "$STAGE/new/$name" bodyRev || true)
  [ -n "$made" ] || die "$name does not say which body made it (continueProduced.bodyRev): not copied"
  [[ "$made" =~ ^[0-9a-fA-F]{7,40}$ ]] || die "$name: bodyRev '$made' is not a hex git revision"
  madefull=$(gitb rev-parse --verify --quiet "$made^{commit}") || die "$name: bodyRev $made is not a commit of the body"
  if [ "$madefull" != "$FULL" ]; then
    gitb diff --quiet "$madefull" "$FULL" -- "${CODE_PATHS[@]}" || die "$name was made by body $made, whose code differs from $REV: a produced file of another version is a fail; run continue-produce.ts at $REV and commit it. Nothing was copied"
  fi
  if [ -z "$MADEBY" ]; then MADEBY=$madefull; elif [ "$MADEBY" != "$madefull" ]; then die "$name was made by $made but another file by $MADEBY: the files must come from one run. Nothing was copied"; fi
  fixture=$(field "$STAGE/new/$name" inputFixture || true)
  if [ -n "$fixture" ]; then
    [[ "$fixture" =~ ^[A-Za-z0-9._/-]+\.json$ ]] && [[ "$fixture" != *..* ]] || die "$name: inputFixture '$fixture' is not a plain relative path"
    [ -f "$HEAD_REPO/$FIX/$fixture" ] || die "$name: the head has no fixture $fixture"
    want=$(field "$STAGE/new/$name" inputSha256 || true)
    [ -n "$want" ] || die "$name names the fixture $fixture but not its sha256 (continueProduced.inputSha256)"
    have=$(sha256sum "$HEAD_REPO/$FIX/$fixture" | cut -d' ' -f1)
    [ "$want" = "$have" ] || die "$name was made from another $fixture than the head's (sha256 $want, the head has $have): the two copies of the fixture differ. Nothing was copied"
  fi
done

{
  printf '{\n "bodyRev": "%s",\n "madeBy": "%s",\n "files": {\n' "$FULL" "$MADEBY"
  first=1
  for file in $(cd "$STAGE/new" && ls | LC_ALL=C sort); do
    [ "$first" = 1 ] || printf ',\n'
    first=0
    printf '  "%s": "%s"' "$file" "$(sha256sum "$STAGE/new/$file" | cut -d' ' -f1)"
  done
  printf '\n }\n}\n'
} > "$STAGE/PRODUCED.json"
mv "$STAGE/PRODUCED.json" "$STAGE/new/PRODUCED.json"

# every file passed: replace the directory at once (a file the body no longer has goes away with it)
rm -rf "$DEST.old" && { [ ! -e "$DEST" ] || mv "$DEST" "$DEST.old"; }
mkdir -p "$(dirname "$DEST")" && mv "$STAGE/new" "$DEST" && rm -rf "$DEST.old"
printf 'copied %d file(s) of body %s into %s\n' "${#PATHS[@]}" "$FULL" "$DEST"
