#!/usr/bin/env bash
# Copies the body's REAL outputs of the "continue" contract into the head's fixtures, from one named revision of the body (contract chapter 9).
#
#   scripts/sync-body-produced.sh <body rev> [--body-repo <path>] [--head-repo <path>]
#
#   <body rev>     a git revision of the body (hex, 7 to 40 digits). A branch name is refused: the copy must name one commit. It is either the commit that
#                  holds the produced files, or the revision of the CODE they were made from: with the second, the produced files are read from the first later
#                  commit that holds them and whose code is the same as <body rev>'s (nothing differs under CODE_PATHS: backend/src, backend/package.json).
#   --body-repo    the body's clone (default $BODY_REPO, else /mnt/c/Shannon/Shannon-continue as WSL sees it, /c/Shannon/Shannon-continue in Git Bash).
#   --head-repo    the head's clone to write into (default: the clone this script is in).
#
# Reads backend/contracts/continue/produced/*.json at that commit (git show: the working tree of the body is never read), and writes
#   <head>/services/api/tests/fixtures/continue/produced/*.json   and   .../produced/PRODUCED.json  ({bodyRev: the commit read, madeBy: the rev the files name, files: {name: sha256}})
# NOTHING IS COPIED unless every file passes (a produced file of another version is a fail, not a warning - chapter 9). The body writes at the top of each file:
#   "producedBy", "bench", "bodyRevision", "madeAt", "answers", "fixtureSha256", then "output". This script reads three of them:
#   - "bodyRevision": a git rev of the body, the same in all files: the body that made them. A file cannot name the commit it is committed in, so "the same as
#     <body rev>" means that commit, or one whose code is the same (nothing differs under CODE_PATHS between it and <body rev>, and between it and the commit read).
#     Any other rev is a fail;
#   - "answers": the head's fixture under tests/fixtures/continue/ the file answers, without ".json" (null for a file that answers none, the catalog);
#   - "fixtureSha256": that fixture's sha256 (null with no fixture); it must be the one of the head's file.
# The files are read with grep, not a JSON parser (the PC's Git Bash has no node): inside a produced file the first "bodyRevision", "answers" and "fixtureSha256" are
# the ones at the top; the payload (under "output") must not come first with them.
# Needs: bash, git, sha256sum, grep, sed.
set -euo pipefail

die() { printf 'sync-body-produced: %s\n' "$*" >&2; exit 1; }
REV=""; BODY_REPO=${BODY_REPO:-}; HEAD_REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --body-repo) [ $# -ge 2 ] || die "--body-repo needs a path"; BODY_REPO=$2; shift 2;;
    --head-repo) [ $# -ge 2 ] || die "--head-repo needs a path"; HEAD_REPO=$2; shift 2;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0;;
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

DEST="$HEAD_REPO/$FIX/produced"
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.sync-produced-XXXXXX")   # beside the destination: the final move stays on one file system
trap 'rm -rf "$STAGE"' EXIT
field() {   # field <file> <key>: the first string value of "key" in the top of the file (the body's header); empty for null
  head -c 2000 "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E 's/^[^:]*:[[:space:]]*"(.*)"$/\1/'
}
same_code() { gitb diff --quiet "$1" "$2" -- "${CODE_PATHS[@]}"; }

# try_commit <commit>: the files of produced/ at that commit, all of one version, staged in $STAGE/new. Returns 1 and sets ERR when they are not.
ERR=""; MADEBY=""; PATHS=()
try_commit() {
  local commit=$1 path name made madefull other fixture want have
  rm -rf "$STAGE/new"; mkdir -p "$STAGE/new"; MADEBY=""
  mapfile -t PATHS < <(gitb ls-tree -r --name-only "$commit" -- "$PRODUCED_DIR/")
  [ "${#PATHS[@]}" -gt 0 ] || { ERR="the body at ${commit:0:12} has no $PRODUCED_DIR/"; return 1; }
  for path in "${PATHS[@]}"; do
    name=${path#"$PRODUCED_DIR/"}
    [[ "$name" =~ ^[A-Za-z0-9._-]+\.json$ ]] || { ERR="unexpected file $path (only flat .json files, plain names, belong in produced/)"; return 1; }
    gitb show "$commit:$path" > "$STAGE/new/$name"
    made=$(field "$STAGE/new/$name" bodyRevision || true)
    [ -n "$made" ] || { ERR="$name does not say which body made it (bodyRevision)"; return 1; }
    [[ "$made" =~ ^[0-9a-fA-F]{7,40}$ ]] || { ERR="$name: bodyRevision '$made' is not a hex git revision"; return 1; }
    madefull=$(gitb rev-parse --verify --quiet "$made^{commit}") || { ERR="$name: bodyRevision $made is not a commit of the body"; return 1; }
    for other in "$FULL" "$commit"; do
      [ "$madefull" = "$other" ] || same_code "$madefull" "$other" || { ERR="$name was made by body $made, whose code differs from ${other:0:12}: a produced file of another version is a fail"; return 1; }
    done
    if [ -z "$MADEBY" ]; then MADEBY=$madefull; elif [ "$MADEBY" != "$madefull" ]; then ERR="$name was made by $made but another file by ${MADEBY:0:12}: the files must come from one run"; return 1; fi
    fixture=$(field "$STAGE/new/$name" answers || true)
    if [ -n "$fixture" ]; then
      fixture="$fixture.json"
      { [[ "$fixture" =~ ^[A-Za-z0-9._/-]+\.json$ ]] && [[ "$fixture" != *..* ]]; } || { ERR="$name: answers '$fixture' is not a plain relative path"; return 1; }
      [ -f "$HEAD_REPO/$FIX/$fixture" ] || { ERR="$name: the head has no fixture $fixture"; return 1; }
      want=$(field "$STAGE/new/$name" fixtureSha256 || true)
      [ -n "$want" ] || { ERR="$name names the fixture $fixture but not its sha256 (fixtureSha256)"; return 1; }
      have=$(sha256sum "$HEAD_REPO/$FIX/$fixture" | cut -d' ' -f1)
      [ "$want" = "$have" ] || { ERR="$name was made from another $fixture than the head's (sha256 $want, the head has $have): the two copies of the fixture differ"; return 1; }
    fi
  done
}

# The commit to read: <body rev> itself when its produced/ is whole and of the same code; else (the revision is the CODE's) the first later commit of the same code that is.
READ=""; FIRST_ERR=""
if try_commit "$FULL"; then READ=$FULL; else
  FIRST_ERR=$ERR
  while IFS= read -r later; do
    same_code "$FULL" "$later" || continue
    if try_commit "$later"; then READ=$later; break; fi
  done < <(gitb rev-list --reverse --topo-order --ancestry-path --all "^$FULL" -- "$PRODUCED_DIR")
fi
[ -n "$READ" ] || die "$FIRST_ERR, and no later commit of the same code has produced files that are whole and current: nothing was copied (run the producer at $REV and commit the files)"

{
  printf '{\n "bodyRev": "%s",\n "madeBy": "%s",\n "files": {\n' "$READ" "$MADEBY"
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
printf 'copied %d file(s) of body %s (made by %s) into %s\n' "${#PATHS[@]}" "$READ" "$MADEBY" "$DEST"
