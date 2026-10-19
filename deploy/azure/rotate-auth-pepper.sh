#!/usr/bin/env bash
# Rotate SHANNON_AUTH_PEPPER without re-pairing any device (deploy/azure/README.md, "Rotating the auth pepper").
#
# Run on the VM as azureuser, fed from a LF file (never as an ssh argument with quotes, `>` or `$( )`):
#   ssh -o BatchMode=yes azure-constant-server bash -s -- <mode> [option] < rotate-auth-pepper.sh
#
# Modes:
#   check                   read only: the env file, the database, the deployed code, the units and /v1/state
#   rotate                  back up api.env, move the pepper to SHANNON_AUTH_PEPPER_PREVIOUS, set a new one, restart, check
#   status                  how many active devices have moved to the new pepper and which have not (authCli pepper-status)
#   rollback [backup]       the backed-up pepper becomes current again and the new one stays as PREVIOUS,
#                           so devices that already moved still match (only the two pepper lines change)
#   rollback-exact [backup] [--force]
#                           restore the backup byte for byte; refused while any device is on the new pepper (--force: they re-pair)
#   finish [--force]        remove SHANNON_AUTH_PEPPER_PREVIOUS at remaining=0 (--force: revoke the devices still left)
#   clean-backups           delete (shred) the before-pepper-* backups, which hold old peppers; only after finish
#
# No pepper, token or digest is ever printed: only names, lengths, counts, file names, unit states and HTTP codes.
# The env file is edited by Python alone; `pepper_status` hands the two peppers to authCli as its environment
# (readable only by azureuser and root, as systemd's EnvironmentFile is), never as an argument.
set -euo pipefail
umask 077

MODE="${1:-check}"
OPTION="${2:-}"
OPTION2="${3:-}"
ENV_FILE=/home/azureuser/.config/shannon-ios/api.env
BACKUP_DIR=/home/azureuser/.config/shannon-ios/backups
APP=/home/azureuser/shannon-ios
NODE=/home/azureuser/shannon-ios-runtime/bin/node
DATABASE=/home/azureuser/shannon-ios-data/shannon.sqlite
STATE_URL=http://127.0.0.1:4319/v1/state
UNITS=(shannon-ios shannon-ios-mind shannon-ios-worker shannon-ios-world shannon-agent-host shannon-ios-autonomy)

say() { printf '[pepper] %s\n' "$*"; }
fail() { say "止めました: $*"; exit 1; }

envtool() {
  python3 - "$@" <<'PY'
import os, re, secrets, sys

PEPPER, PREVIOUS = 'SHANNON_AUTH_PEPPER=', 'SHANNON_AUTH_PEPPER_PREVIOUS='

def die(message):
    print('[pepper] 止めました: ' + message)
    sys.exit(1)

def read(path):
    with open(path, encoding='utf-8', newline='') as handle:
        return handle.read().splitlines(keepends=True)

def newline_of(lines):
    return '\r\n' if lines and lines[0].endswith('\r\n') else '\n'

def pepper_of(lines, label):
    found = [index for index, line in enumerate(lines) if line.startswith(PEPPER)]
    if len(found) != 1:
        die(f'{label}: SHANNON_AUTH_PEPPER の行が {len(found)} 個あります（1 個のはず）')
    value = lines[found[0]][len(PEPPER):].rstrip('\r\n')
    if len(value) < 32 or re.search(r'[\s"\'$`\\]', value):
        die(f'{label}: SHANNON_AUTH_PEPPER の形が想定と違います（32 文字以上で、引用符・空白・記号 $ ` \\ なし）')
    return value

def previous_of(lines, label):
    found = [index for index, line in enumerate(lines) if line.startswith(PREVIOUS)]
    if len(found) > 1:
        die(f'{label}: SHANNON_AUTH_PEPPER_PREVIOUS の行が {len(found)} 個あります')
    return lines[found[0]][len(PREVIOUS):].rstrip('\r\n').strip() if found else ''

def with_peppers(lines, current, previous):
    """The same file with only the two pepper lines replaced: PREVIOUS right after the pepper line, or gone when None."""
    lines = [line for line in lines if not line.startswith(PREVIOUS)]
    newline = newline_of(lines)
    index = next(index for index, line in enumerate(lines) if line.startswith(PEPPER))
    lines[index] = PEPPER + current + newline
    if previous is not None:
        lines.insert(index + 1, PREVIOUS + previous + newline)
    return lines

def write(path, lines):
    temporary = path + '.pepper-tmp'
    if os.path.exists(temporary):
        os.unlink(temporary)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='') as handle:
        handle.write(''.join(lines))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)

def verify(path, current, previous):
    lines = read(path)
    if pepper_of(lines, '書き込んだ api.env') != current or previous_of(lines, '書き込んだ api.env') != (previous or ''):
        die('書き込んだ api.env の確かめに失敗しました')

action, path = sys.argv[1], sys.argv[2]
argument = sys.argv[3] if len(sys.argv) > 3 else ''

if action == 'inspect':
    lines = read(path)
    current, previous = pepper_of(lines, path), previous_of(lines, path)
    print(f'[pepper] SHANNON_AUTH_PEPPER: あり（{len(current)} 文字）')
    print('[pepper] SHANNON_AUTH_PEPPER_PREVIOUS: ' + ('あり' if previous else 'なし'))
    if previous and previous == current:
        die('SHANNON_AUTH_PEPPER_PREVIOUS が SHANNON_AUTH_PEPPER と同じです（API は起動を断ります）')
    if argument == 'require-no-previous' and previous:
        die('SHANNON_AUTH_PEPPER_PREVIOUS がもうあります。前の切り替えを finish してから行ってください')
    if argument == 'require-previous' and not previous:
        die('SHANNON_AUTH_PEPPER_PREVIOUS がありません（切り替えの途中ではありません）')

elif action == 'rotate':
    lines = read(path)
    old = pepper_of(lines, 'api.env')
    if previous_of(lines, 'api.env'):
        die('SHANNON_AUTH_PEPPER_PREVIOUS がもうあります')
    new = secrets.token_hex(32)
    write(path, with_peppers(lines, new, old))
    verify(path, new, old)
    print('[pepper] api.env を書き換えました（前の値 → SHANNON_AUTH_PEPPER_PREVIOUS、新しい値 → SHANNON_AUTH_PEPPER）')

elif action == 'swap-back':
    # The current file stays the base (other settings changed since the rotation are kept); the backup only gives the pepper.
    lines = read(path)
    current = pepper_of(lines, '今の api.env')
    old = pepper_of(read(argument), '控え')
    keep = current if current != old else None
    write(path, with_peppers(lines, old, keep))
    verify(path, old, keep)
    print('[pepper] 控えの値を SHANNON_AUTH_PEPPER に戻しました' + ('（新しい値は SHANNON_AUTH_PEPPER_PREVIOUS に残しました）' if keep else ''))

elif action == 'drop-previous':
    lines = read(path)
    current = pepper_of(lines, 'api.env')
    write(path, with_peppers(lines, current, None))
    verify(path, current, None)
    print('[pepper] SHANNON_AUTH_PEPPER_PREVIOUS の行を消しました')

else:
    die('unknown envtool action')
PY
}

env_value() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2- | tr -d '\r'; }

authcli() {
  (
    cd "$APP"
    SHANNON_AUTH_PEPPER="$(env_value SHANNON_AUTH_PEPPER)" SHANNON_AUTH_PEPPER_PREVIOUS="$(env_value SHANNON_AUTH_PEPPER_PREVIOUS)" \
      SHANNON_DATABASE_PATH="$DATABASE" SHANNON_AUTH_MODE=paired \
      "$NODE" --import tsx services/api/src/authCli.ts "$@" < /dev/null
  )
}

pepper_status() { authcli pepper-status; }

status_field() { printf '%s\n' "$1" | sed -n "s/^$2=\\([0-9][0-9]*\\)\$/\\1/p" | tail -n 1; }

api_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$STATE_URL" < /dev/null || true; }

api_pid() { systemctl show -p MainPID --value shannon-ios < /dev/null || true; }

wait_api() {
  local code=''
  for _ in $(seq 1 20); do
    code="$(api_code)"
    if [ "$code" = 401 ]; then say "/v1/state: 401（トークン無しは断る＝期待どおり）"; return 0; fi
    sleep 2
  done
  say "/v1/state: ${code:-応答なし}（401 になりませんでした）"
  return 1
}

# Each unit in order, 3 seconds apart; fails when shannon-ios itself could not be restarted.
restart_all() {
  local unit ok=0
  for unit in "${UNITS[@]}"; do
    if ! sudo -n systemctl restart "$unit" < /dev/null; then
      say "$unit: 再起動のコマンドが失敗しました"
      [ "$unit" = shannon-ios ] && ok=1
    fi
    sleep 3
    say "$unit: $(systemctl is-active "$unit" < /dev/null || true)"
  done
  return "$ok"
}

# The API is up on the new settings: restarted (a new main PID) and answering /v1/state with 401.
restart_and_check() {
  local before
  before="$(api_pid)"
  restart_all || return 1
  [ "$(api_pid)" != "$before" ] || { say "shannon-ios の PID が変わっていません（再起動されていません）"; return 1; }
  wait_api
}

backup_env() {
  local target
  target="$BACKUP_DIR/api.env.$(date -u +%Y%m%dT%H%M%SZ).$1"
  cp -p "$ENV_FILE" "$target"
  chmod 600 "$target"
  say "控え: $target"
  BACKUP_PATH="$target"
}

latest_backup() {
  { ls -1t "$BACKUP_DIR"/api.env.*."$1" 2> /dev/null || true; } | head -n 1
}

chosen_backup() {
  local backup="${1:-$(latest_backup before-pepper-rotation)}"
  [ -n "$backup" ] && [ -f "$backup" ] || fail "切り替えの控えが見つかりません"
  case "$(readlink -f "$backup")" in
    "$BACKUP_DIR"/api.env.*.before-pepper-*) ;;
    *) fail "控えは $BACKUP_DIR/api.env.*.before-pepper-* から選んでください" ;;
  esac
  envtool inspect "$backup" > /dev/null
  CHOSEN_BACKUP="$backup"
}

preflight() {
  [ "$(id -un)" = azureuser ] || fail "azureuser で動かしてください"
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE がありません"
  [ "$(stat -c %a "$ENV_FILE")" = 600 ] || fail "$ENV_FILE の権限が 600 ではありません"
  [ -f "$DATABASE" ] || fail "$DATABASE がありません（違う場所の DB を数えると、移った数を誤ります）"
  command -v python3 > /dev/null || fail "python3 がありません"
  sudo -n true < /dev/null || fail "sudo -n が使えません"
  grep -q SHANNON_AUTH_PEPPER_PREVIOUS "$APP/services/api/src/infra/auth/deviceAuth.ts" \
    || fail "本番のコードが SHANNON_AUTH_PEPPER_PREVIOUS を知りません。先に新しいコードを反映してください"
  grep -q 'moved=' "$APP/services/api/src/authCli.ts" || fail "本番の authCli.ts に pepper-status がありません"
  envtool inspect "$ENV_FILE" "${1:-}"
}

[ -d "$BACKUP_DIR" ] || mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec 8> "$BACKUP_DIR/.pepper-rotation.lock"
flock -n 8 || fail "別の rotate-auth-pepper.sh が動いています"

case "$MODE" in
  check)
    preflight
    for unit in "${UNITS[@]}"; do say "$unit: $(systemctl is-active "$unit" < /dev/null || true)"; done
    say "/v1/state: $(api_code)"
    ;;

  rotate)
    preflight require-no-previous
    [ "$(api_code)" = 401 ] || fail "切り替えの前に /v1/state が 401 ではありません"
    backup_env before-pepper-rotation
    rotation_backup="$BACKUP_PATH"
    envtool rotate "$ENV_FILE"
    say "再起動（$(date -u +%Y-%m-%dT%H:%M:%SZ)）"
    if ! restart_and_check; then
      # Some devices may already be on the new pepper: swap back (both still match) rather than restore the file as it was.
      say "API が新しい設定で戻らないので、前の値を今の値に、新しい値を PREVIOUS に入れ替えます"
      envtool swap-back "$ENV_FILE" "$rotation_backup"
      restart_and_check || true
      pepper_status || true
      fail "切り替えは取り消しました（PREVIOUS は新しい値）。journalctl -u shannon-ios で理由を見てください"
    fi
    pepper_status
    say "完了。各端末は次の通信で新しい値に移ります。数分後の status で moved が増えていれば、新しい値で通っています"
    say "remaining=0 になったら finish"
    ;;

  status)
    preflight
    pepper_status
    ;;

  rollback)
    preflight require-previous
    chosen_backup "$OPTION"
    say "戻す元: $CHOSEN_BACKUP"
    backup_env before-pepper-rollback
    envtool swap-back "$ENV_FILE" "$CHOSEN_BACKUP"
    restart_and_check || fail "戻した後も API が新しい設定で戻りません"
    pepper_status
    ;;

  rollback-exact)
    if [ "$OPTION" = --force ]; then OPTION="$OPTION2"; OPTION2=--force; fi
    preflight
    chosen_backup "$OPTION"
    status_output="$(pepper_status)" || status_output=''
    printf '%s\n' "$status_output"
    moved="$(status_field "$status_output" moved)"
    if [ "${moved:-unknown}" != 0 ] && [ "$OPTION2" != --force ]; then
      fail "新しい値に移った端末が ${moved:-何台か分からない数} あります。rollback を使うか、ペアリングのやり直しを受け入れて rollback-exact --force"
    fi
    say "戻す元: $CHOSEN_BACKUP"
    backup_env before-pepper-rollback
    cp -p "$CHOSEN_BACKUP" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    say "控えをそのまま戻しました"
    restart_and_check || fail "戻した後も API が新しい設定で戻りません"
    pepper_status || true
    ;;

  finish)
    preflight require-previous
    status_output="$(pepper_status)"
    printf '%s\n' "$status_output"
    remaining="$(status_field "$status_output" remaining)"
    [ -n "$remaining" ] || fail "pepper-status の remaining が読めません"
    if [ "$remaining" != 0 ]; then
      [ "$OPTION" = --force ] || fail "まだ $remaining 台が移っていません。待つか、その端末を諦めるなら finish --force"
      # Given up: revoked, so they stop counting toward the active-device limit and can pair again.
      for device in $(printf '%s\n' "$status_output" | sed -n 's/^まだ  \([0-9a-f]\{16\}\)  .*/\1/p'); do
        authcli revoke "$device"
      done
    fi
    backup_env before-pepper-finish
    envtool drop-previous "$ENV_FILE"
    restart_and_check || fail "PREVIOUS を外した後に API が戻りません。rollback-exact $BACKUP_PATH で戻せます"
    pepper_status
    say "完了。控え（before-pepper-*）には前の値が入っています。様子を見て clean-backups で消してください"
    ;;

  clean-backups)
    preflight require-no-previous
    found=0
    for backup in "$BACKUP_DIR"/api.env.*.before-pepper-*; do
      [ -f "$backup" ] || continue
      shred -u "$backup"
      say "消しました: $backup"
      found=1
    done
    [ "$found" = 1 ] || say "消す控えはありません"
    ;;

  *)
    fail "モードは check | rotate | status | rollback | rollback-exact | finish [--force] | clean-backups"
    ;;
esac
