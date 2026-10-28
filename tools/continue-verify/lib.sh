# Shared by run-boundary.sh and collect.sh (sourced, never run). LF only: files that go to a VM must have no CR.
die() { printf 'continue-verify: %s\n' "$*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }

SCENE_RE='^(boundary-([1-79]|10)|seam-[1-8]|b8-[a-z]+(-[a-z]+)*)$'
REV_RE='^[0-9a-f]{7,40}$'
RUN_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
BENCH_RE='^[ABCD](,[ABCD])*$'
VM_RE='^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$'
PATH_RE='^[A-Za-z0-9_./~+-]+$'     # a path that goes into a command line on the VM: no space, quote, $, ;, &, |, backtick

check_re() {   # check_re <name> <value> <regex>
  [[ "$2" =~ $3 ]] || die "$1: '$2' is not valid"
}
need() {       # need <name> <value>
  [ -n "${2:-}" ] || die "missing $1"
}
here() { cd "$(dirname "${BASH_SOURCE[1]}")" && pwd; }
