#!/usr/bin/env bash
# Rotate SHANNON_AUTH_PEPPER without re-pairing any device (deploy/azure/README.md, "Rotating the auth pepper").
#
# Run on the VM as azureuser, fed from a LF file (never as an ssh argument with quotes, `>` or `$( )`):
#   ssh -o BatchMode=yes azure-constant-server bash -s -- <mode> < rotate-auth-pepper.sh
#
# Modes:
#   check           read only: the env file, the deployed code, the units and /v1/state
#   rotate          back up api.env, move the pepper to SHANNON_AUTH_PEPPER_PREVIOUS, set a new one, restart, check
#   status          how many active devices are still not on the new pepper (authCli pepper-status)
#   rollback        put the backed-up pepper back as current and keep the new one as PREVIOUS (devices already moved still match)
#   rollback-exact  restore the backup byte for byte (only when no device can have moved: the API never came up)
#   finish [--force]  remove SHANNON_AUTH_PEPPER_PREVIOUS once status reports remaining=0 (--force: drop the devices still left)
#
# No pepper, token or digest is ever printed: only names, lengths, counts, file names, unit states and HTTP codes.
set -euo pipefail
umask 077

MODE="${1:-check}"
OPTION="${2:-}"
ENV_FILE=/home/azureuser/.config/shannon-ios/api.env
BACKUP_DIR=/home/azureuser/.config/shannon-ios/backups
APP=/home/azureuser/shannon-ios
NODE=/home/azureuser/shannon-ios-runtime/bin/node
DATABASE=/home/azureuser/shannon-ios-data/shannon.sqlite
STATE_URL=http://127.0.0.1:4319/v1/state
UNITS=(shannon-ios shannon-ios-mind shannon-ios-worker shannon-ios-world shannon-agent-host shannon-ios-autonomy)

say() { printf '[pepper] %s\n' "$*"; }
fail() { say "止めました: $*"; exit 1; }

# The env file is edited by Python only: the old value never passes through a shell variable or an argument.
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

def ending(line, fallback):
    end = line[len(line.rstrip('\r\n')):]
    return end or fallback

def newline_of(lines):
    return '\r\n' if lines and lines[0].endswith('\r\n') else '\n'

def pepper_of(lines, label):
    found = [index for index, line in enumerate(lines) if line.startswith(PEPPER)]
    if len(found) != 1:
        die(f'{label}: SHANNON_AUTH_PEPPER の行が {len(found)} 個あります（1 個のはず）')
    value = lines[found[0]][len(PEPPER):].rstrip('\r\n')
    if len(value) < 32 or re.search(r'[\s"\'$`\\]', value):
        die(f'{label}: SHANNON_AUTH_PEPPER の形が想定と違います（32 文字以上で、引用符・空白・記号 $ ` \\ なし）')
    return found[0], value

def previous_of(lines, label):
    found = [index for index, line in enumerate(lines) if line.startswith(PREVIOUS)]
    if len(found) > 1:
        die(f'{label}: SHANNON_AUTH_PEPPER_PREVIOUS の行が {len(found)} 個あります')
    if not found:
        return None, ''
    return found[0], lines[found[0]][len(PREVIOUS):].rstrip('\r\n').strip()

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

def set_previous(lines, pepper_index, value):
    """SHANNON_AUTH_PEPPER_PREVIOUS=value right after the pepper line (replacing any existing one); None removes it."""
    lines = [line for line in lines if not line.startswith(PREVIOUS)]
    pepper_index = next(index for index, line in enumerate(lines) if line.startswith(PEPPER))
    newline = newline_of(lines)
    lines[pepper_index] = lines[pepper_index].rstrip('\r\n') + ending(lines[pepper_index], newline)
    if value is not None:
        lines.insert(pepper_index + 1, PREVIOUS + value + newline)
    return lines

action, path = sys.argv[1], sys.argv[2]

if action == 'inspect':
    lines = read(path)
    _, current = pepper_of(lines, 'api.env')
    _, previous = previous_of(lines, 'api.env')
    print(f'[pepper] SHANNON_AUTH_PEPPER: あり（{len(current)} 文字）')
    print('[pepper] SHANNON_AUTH_PEPPER_PREVIOUS: ' + ('あり' if previous else 'なし'))
    if previous and previous == current:
        die('SHANNON_AUTH_PEPPER_PREVIOUS が SHANNON_AUTH_PEPPER と同じです（API は起動を断ります）')
    if len(sys.argv) > 3 and sys.argv[3] == 'require-no-previous' and previous:
        die('SHANNON_AUTH_PEPPER_PREVIOUS がもうあります。前の切り替えを finish してから行ってください')
    if len(sys.argv) > 3 and sys.argv[3] == 'require-previous' and not previous:
        die('SHANNON_AUTH_PEPPER_PREVIOUS がありません（切り替えの途中ではありません）')

elif action == 'rotate':
    lines = read(path)
    index, old = pepper_of(lines, 'api.env')
    _, previous = previous_of(lines, 'api.env')
    if previous:
        die('SHANNON_AUTH_PEPPER_PREVIOUS がもうあります')
    new = secrets.token_hex(32)
    lines[index] = PEPPER + new + ending(lines[index], newline_of(lines))
    write(path, set_previous(lines, index, old))
    check = read(path)
    _, written = pepper_of(check, '書き込んだ api.env')
    _, moved = previous_of(check, '書き込んだ api.env')
    if written != new or moved != old or written == old:
        die('書き込んだ api.env の確かめに失敗しました。rollback-exact で控えに戻してください')
    print('[pepper] api.env を書き換えました（前の値 → SHANNON_AUTH_PEPPER_PREVIOUS、新しい値 → SHANNON_AUTH_PEPPER）')

elif action == 'swap-back':
    backup = sys.argv[3]
    _, current = pepper_of(read(path), '今の api.env')
    restored = read(backup)
    index, old = pepper_of(restored, '控え')
    write(path, set_previous(restored, index, current if current != old else None))
    print('[pepper] 控えの値を SHANNON_AUTH_PEPPER に戻しました' + ('（新しい値は SHANNON_AUTH_PEPPER_PREVIOUS に残しました）' if current != old else ''))

elif action == 'drop-previous':
    lines = read(path)
    index, _ = pepper_of(lines, 'api.env')
    write(path, set_previous(lines, index, None))
    print('[pepper] SHANNON_AUTH_PEPPER_PREVIOUS の行を消しました')

else:
    die('unknown envtool action')
PY
}

env_value() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2- | tr -d '\r'; }

pepper_status() {
  (
    cd "$APP"
    SHANNON_AUTH_PEPPER="$(env_value SHANNON_AUTH_PEPPER)" SHANNON_AUTH_PEPPER_PREVIOUS="$(env_value SHANNON_AUTH_PEPPER_PREVIOUS)" \
      SHANNON_DATABASE_PATH="$DATABASE" SHANNON_AUTH_MODE=paired \
      "$NODE" --import tsx services/api/src/authCli.ts pepper-status < /dev/null
  )
}

api_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$STATE_URL" < /dev/null || true; }

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

restart_all() {
  local unit
  for unit in "${UNITS[@]}"; do
    sudo -n systemctl restart "$unit" < /dev/null || say "$unit: 再起動のコマンドが失敗しました"
    sleep 3
    say "$unit: $(systemctl is-active "$unit" < /dev/null || true)"
  done
}

backup_env() {
  local target
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  target="$BACKUP_DIR/api.env.$(date -u +%Y%m%dT%H%M%SZ).$1"
  cp -p "$ENV_FILE" "$target"
  chmod 600 "$target"
  say "控え: $target"
  BACKUP_PATH="$target"
}

preflight() {
  [ "$(id -un)" = azureuser ] || fail "azureuser で動かしてください"
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE がありません"
  [ "$(stat -c %a "$ENV_FILE")" = 600 ] || fail "$ENV_FILE の権限が 600 ではありません"
  command -v python3 > /dev/null || fail "python3 がありません"
  sudo -n true < /dev/null || fail "sudo -n が使えません"
  grep -q SHANNON_AUTH_PEPPER_PREVIOUS "$APP/services/api/src/infra/auth/deviceAuth.ts" \
    || fail "本番のコードが SHANNON_AUTH_PEPPER_PREVIOUS を知りません。先に新しいコードを反映してください"
  grep -q pepper-status "$APP/services/api/src/authCli.ts" || fail "本番の authCli.ts に pepper-status がありません"
  envtool inspect "$ENV_FILE" "${1:-}"
  local unit
  for unit in "${UNITS[@]}"; do say "$unit: $(systemctl is-active "$unit" < /dev/null || true)"; done
}

latest_backup() {
  { ls -1t "$BACKUP_DIR"/api.env.*."$1" 2> /dev/null || true; } | head -n 1
}

case "$MODE" in
  check)
    preflight
    say "/v1/state: $(api_code)"
    ;;

  rotate)
    preflight require-no-previous
    [ "$(api_code)" = 401 ] || fail "切り替えの前に /v1/state が 401 ではありません"
    backup_env before-pepper-rotation
    rotation_backup="$BACKUP_PATH"
    envtool rotate "$ENV_FILE"
    [ "$(stat -c %a "$ENV_FILE")" = 600 ] || fail "書き換えた $ENV_FILE の権限が 600 ではありません"
    say "再起動（$(date -u +%Y-%m-%dT%H:%M:%SZ)）"
    restart_all
    if ! wait_api; then
      say "API が戻らないので、控えをそのまま戻します（どの端末もまだ移っていません）"
      cp -p "$rotation_backup" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      restart_all
      wait_api || true
      fail "切り替えは取り消しました。journalctl -u shannon-ios で理由を見てください"
    fi
    pepper_status
    say "完了。各端末は次の通信で新しい値に移ります。status で残りを見て、remaining=0 になったら finish"
    ;;

  status)
    envtool inspect "$ENV_FILE"
    pepper_status
    ;;

  rollback|rollback-exact)
    backup="${OPTION:-$(latest_backup before-pepper-rotation)}"
    [ -n "$backup" ] && [ -f "$backup" ] || fail "切り替えの控えが見つかりません"
    say "戻す元: $backup"
    backup_env before-pepper-rollback
    if [ "$MODE" = rollback-exact ]; then
      cp -p "$backup" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      say "控えをそのまま戻しました（新しい値で移った端末は、ペアリングのやり直しが要ります）"
    else
      envtool swap-back "$ENV_FILE" "$backup"
    fi
    restart_all
    wait_api || fail "戻した後も /v1/state が 401 になりません"
    pepper_status
    ;;

  finish)
    envtool inspect "$ENV_FILE" require-previous
    status_output="$(pepper_status)"
    printf '%s\n' "$status_output"
    remaining="$(printf '%s\n' "$status_output" | sed -n 's/^remaining=//p')"
    [ -n "$remaining" ] || fail "pepper-status の remaining が読めません"
    if [ "$remaining" != 0 ] && [ "$OPTION" != --force ]; then
      fail "まだ $remaining 台が移っていません。待つか、その端末を諦めるなら finish --force"
    fi
    backup_env before-pepper-finish
    envtool drop-previous "$ENV_FILE"
    restart_all
    wait_api || fail "PREVIOUS を外した後に /v1/state が 401 になりません。rollback-exact $BACKUP_PATH で戻せます"
    pepper_status
    say "完了。切り替えの控え（before-pepper-*）には前の値が入っています。要らなくなったら消してください"
    ;;

  *)
    fail "モードは check | rotate | status | rollback | rollback-exact | finish [--force]"
    ;;
esac
