#!/usr/bin/env python3
"""Minebot section time trials on shannon-home (README.md in this directory).

Runs on the production VM as azureuser, from ~/minecraft/shannon-home/trials (python3 -I trials.py ...). Standard library only.

  scout   --key K --seed S        make the pristine practice world of one seed and measure it (village, lava, trees, sheep ...)
  seedof  <world dir>...          print the seed of existing worlds (level.dat)
  run     [--sections 1,2] [--seeds a,b] [--model sonnet] [--dry-run]
                                  one batch: each section on each of its seeds, from a fresh copy of the pristine world
  report  [--batch B]             the table of one batch next to the previous result of each section and seed
  restore                         put the production world settings back (after an interrupted batch)
  env     on|off|status           the temporary SHANNON_FCA_MODEL line in api.env (with the six service restarts)

The production world directory (level-name in server.properties, normally shannon_home) is never moved or written: a trial
switches level-name to trial_live, a copy of the pristine world, and switches it back at the end. world-id is switched too, so
the body keeps the places of each trial apart. Secrets (RCON password, api.env values) are never printed.
"""
import argparse
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import time
import zlib

HOME = os.path.expanduser('~')
MC = os.path.join(HOME, 'minecraft', 'shannon-home')
HERE = os.path.dirname(os.path.abspath(__file__))
PRISTINE = os.path.join(HERE, 'pristine')
RESULTS = os.path.join(HERE, 'results')
BACKUPS = os.path.join(HERE, 'backups')
STATE = os.path.join(HERE, 'state.json')
LIVE = 'trial_live'
SCOUT = 'trial_scout'
MARK = '.shannon-trial-world'
BODY = 'I_am_Shannon'
IOS = os.path.join(HOME, 'shannon-ios')
DB = os.path.join(HOME, 'shannon-ios-data', 'shannon.sqlite')
NODE = os.path.join(HOME, 'shannon-ios-runtime', 'bin', 'node')
API_ENV = os.path.join(HOME, '.config', 'shannon-ios', 'api.env')
ENV_BACKUPS = os.path.join(HOME, 'shannon-ios-data', 'deploy-backups')
SERVICES = ['shannon-ios', 'shannon-ios-mind', 'shannon-ios-worker', 'shannon-ios-world', 'shannon-agent-host', 'shannon-ios-autonomy']
MODEL_LINE = b'SHANNON_FCA_MODEL=claude-sonnet-5-5\n'
GOAL = 'エンドラを討伐してください'
OPERATOR = 'trials'
RATE_PER_HOUR = 20          # OPERATOR_LIMITS.requestsPerHour (accepted invocations of every operator)
TERMINAL = {'completed', 'failed', 'cancelled', 'paused'}


def log(*parts):
    print(dt.datetime.now().strftime('%H:%M:%S'), *parts, flush=True)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def jst_stamp(seconds=False):
    t = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    return t.strftime('%Y%m%dT%H%M%S' if seconds else '%Y%m%dT%H%M')


def load_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def save_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.replace(tmp, path)


class Stop(Exception):
    """The batch cannot go on (the reason is printed and recorded)."""


# ---------------------------------------------------------------- NBT and region files

def nbt_read(data):
    """A whole NBT document (uncompressed bytes) as Python values; the root's name is dropped."""
    buf = io.BytesIO(data)

    def rd(fmt):
        size = struct.calcsize(fmt)
        return struct.unpack(fmt, buf.read(size))

    def string():
        (n,) = rd('>H')
        return buf.read(n).decode('utf-8', 'replace')

    def payload(tag):
        if tag == 1: return rd('>b')[0]
        if tag == 2: return rd('>h')[0]
        if tag == 3: return rd('>i')[0]
        if tag == 4: return rd('>q')[0]
        if tag == 5: return rd('>f')[0]
        if tag == 6: return rd('>d')[0]
        if tag == 7:
            (n,) = rd('>i'); return buf.read(n)
        if tag == 8: return string()
        if tag == 9:
            sub, n = rd('>bi')
            return [payload(sub) for _ in range(n)]
        if tag == 10:
            out = {}
            while True:
                (t,) = rd('>b')
                if t == 0: return out
                name = string()
                out[name] = payload(t)
        if tag == 11:
            (n,) = rd('>i'); return list(struct.unpack('>%di' % n, buf.read(4 * n)))
        if tag == 12:
            (n,) = rd('>i'); return list(struct.unpack('>%dq' % n, buf.read(8 * n)))
        raise ValueError('bad NBT tag %d' % tag)

    (tag,) = rd('>b')
    string()
    return payload(tag)


def level_dat(world):
    with gzip.open(os.path.join(world, 'level.dat'), 'rb') as handle:
        return nbt_read(handle.read()).get('Data', {})


def world_seed(world):
    data = level_dat(world)
    wgs = data.get('WorldGenSettings') or {}
    if 'seed' in wgs: return wgs['seed']
    return data.get('RandomSeed')


def world_spawn(world):
    """The overworld spawn [x, y, z] from level.dat (1.21.11 keeps it under spawn.pos; older ones in SpawnX/Y/Z)."""
    data = level_dat(world)
    spawn = data.get('spawn')
    if isinstance(spawn, dict) and isinstance(spawn.get('pos'), list):
        return list(spawn['pos'])
    if 'SpawnX' in data:
        return [data['SpawnX'], data['SpawnY'], data['SpawnZ']]
    return None


def region_chunks(path):
    """(chunk x, chunk z, NBT) of every chunk stored in one .mca file."""
    with open(path, 'rb') as handle:
        raw = handle.read()
    if len(raw) < 8192: return
    for i in range(1024):
        entry = struct.unpack('>I', raw[i * 4:i * 4 + 4])[0]
        offset, sectors = entry >> 8, entry & 0xFF
        if not offset or not sectors: continue
        start = offset * 4096
        length, kind = struct.unpack('>IB', raw[start:start + 5])
        body = raw[start + 5:start + 4 + length]
        if kind == 2: body = zlib.decompress(body)
        elif kind == 1: body = gzip.decompress(body)
        elif kind != 3: continue        # lz4 or an external file: not used by this server
        yield nbt_read(body)


def unpack_indices(longs, bits, count=4096):
    """Indices packed without spanning longs (1.16+)."""
    per = 64 // bits
    mask = (1 << bits) - 1
    out = []
    for value in longs:
        value &= 0xFFFFFFFFFFFFFFFF
        for _ in range(per):
            out.append(value & mask)
            value >>= bits
            if len(out) == count: return out
    return out


def section_blocks(section):
    """(palette names, indices or None when the section holds one block)."""
    states = section.get('block_states') or {}
    palette = [p.get('Name', '') for p in states.get('palette', [])]
    data = states.get('data')
    if not data or len(palette) <= 1: return palette, None
    bits = max(4, (len(palette) - 1).bit_length())
    return palette, unpack_indices(data, bits)


def section_biome_at(section, lx, ly, lz):
    biomes = section.get('biomes') or {}
    palette = biomes.get('palette', [])
    data = biomes.get('data')
    if not palette: return None
    if not data or len(palette) == 1: return palette[0]
    bits = max(1, (len(palette) - 1).bit_length())
    idx = unpack_indices(data, bits, 64)
    return palette[idx[((ly >> 2) * 4 + (lz >> 2)) * 4 + (lx >> 2)]]


LOGS = re.compile(r'^minecraft:(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$')
SHEEP_BIOMES = {'minecraft:plains', 'minecraft:sunflower_plains', 'minecraft:meadow', 'minecraft:forest', 'minecraft:flower_forest',
                'minecraft:birch_forest', 'minecraft:old_growth_birch_forest', 'minecraft:taiga', 'minecraft:old_growth_pine_taiga',
                'minecraft:old_growth_spruce_taiga', 'minecraft:savanna', 'minecraft:savanna_plateau', 'minecraft:windswept_hills',
                'minecraft:windswept_forest', 'minecraft:cherry_grove', 'minecraft:dark_forest', 'minecraft:pale_garden'}


def scan_world(world, spawn, radius):
    """What a body near spawn would care about, read from the stored chunks within `radius` blocks (horizontal)."""
    sx, sy, sz = spawn
    best = {}
    counts = {'surface_lava_blocks': 0, 'logs_within_32': 0, 'iron_ore_within_48': 0, 'coal_ore_within_48': 0,
              'deep_lava_chunks': 0, 'obsidian_blocks': 0, 'chunks': 0}
    spawn_biome = None

    def near(kind, x, y, z):
        d = math.dist((x, z), (sx, sz))
        if kind not in best or d < best[kind][0]: best[kind] = (round(d, 1), [x, y, z])
        return d

    rx0, rx1 = (sx - radius) >> 9, (sx + radius) >> 9
    rz0, rz1 = (sz - radius) >> 9, (sz + radius) >> 9
    for rx in range(rx0, rx1 + 1):
        for rz in range(rz0, rz1 + 1):
            path = os.path.join(world, 'region', f'r.{rx}.{rz}.mca')
            if not os.path.exists(path): continue
            for chunk in region_chunks(path):
                cx, cz = chunk.get('xPos'), chunk.get('zPos')
                if cx is None or not str(chunk.get('Status', '')).endswith('full'): continue
                bx, bz = cx * 16, cz * 16
                if math.dist((bx + 8, bz + 8), (sx, sz)) > radius + 12: continue
                counts['chunks'] += 1
                chunk_d = math.dist((bx + 8, bz + 8), (sx, sz))
                deep_lava = False
                for section in chunk.get('sections', []):
                    y0 = section.get('Y', 0) * 16
                    if bx <= sx < bx + 16 and bz <= sz < bz + 16 and y0 <= sy < y0 + 16:
                        spawn_biome = section_biome_at(section, sx - bx, sy - y0, sz - bz)
                    palette, idx = section_blocks(section)
                    names = set(palette)
                    if 'minecraft:lava' in names and y0 < 0: deep_lava = True
                    wanted = {n for n in names if n in ('minecraft:lava', 'minecraft:obsidian', 'minecraft:diamond_ore',
                                                         'minecraft:deepslate_diamond_ore') or LOGS.match(n)}
                    if chunk_d <= 60: wanted |= {n for n in names if n.endswith('iron_ore') or n.endswith('coal_ore')}
                    if 'minecraft:lava' in wanted and y0 < 32: wanted.discard('minecraft:lava')   # deep lava: presence only
                    if not wanted: continue
                    if idx is None: idx = [0] * 4096
                    hit = {i for i, n in enumerate(palette) if n in wanted}
                    for pos, p in enumerate(idx):
                        if p not in hit: continue
                        name = palette[p]
                        x, y, z = bx + (pos & 15), y0 + (pos >> 8), bz + ((pos >> 4) & 15)
                        if name == 'minecraft:lava':
                            d = near('surface_lava', x, y, z)
                            if d <= radius: counts['surface_lava_blocks'] += 1
                        elif name == 'minecraft:obsidian':
                            near('obsidian', x, y, z); counts['obsidian_blocks'] += 1
                        elif name.endswith('diamond_ore'):
                            near('diamond_ore', x, y, z)
                        elif name.endswith('iron_ore'):
                            if near('iron_ore', x, y, z) <= 48: counts['iron_ore_within_48'] += 1
                        elif name.endswith('coal_ore'):
                            if near('coal_ore', x, y, z) <= 48: counts['coal_ore_within_48'] += 1
                        else:
                            if near('log', x, y, z) <= 32: counts['logs_within_32'] += 1
                if deep_lava:
                    counts['deep_lava_chunks'] += 1
                    near('deep_lava_chunk', bx + 8, -54, bz + 8)
    animals = {}
    for rx in range(rx0, rx1 + 1):
        for rz in range(rz0, rz1 + 1):
            path = os.path.join(world, 'entities', f'r.{rx}.{rz}.mca')
            if not os.path.exists(path): continue
            for chunk in region_chunks(path):
                for entity in chunk.get('Entities', []):
                    kind = str(entity.get('id', '')).replace('minecraft:', '')
                    if kind not in ('sheep', 'cow', 'pig', 'chicken', 'rabbit'): continue
                    pos = entity.get('Pos') or [0, 0, 0]
                    d = math.dist((pos[0], pos[2]), (sx, sz))
                    if d > radius: continue
                    animals[kind] = animals.get(kind, 0) + 1
                    near(kind, int(pos[0]), int(pos[1]), int(pos[2]))
    return {'spawnBiome': spawn_biome, 'counts': counts, 'animals': animals,
            'nearest': {k: {'distance': v[0], 'at': v[1]} for k, v in sorted(best.items())}}


# ---------------------------------------------------------------- RCON and the server

def properties():
    values = {}
    with open(os.path.join(MC, 'server.properties'), encoding='utf-8') as handle:
        for line in handle:
            line = line.rstrip('\n')
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                values[key.strip()] = value
    return values


def set_property(key, value):
    path = os.path.join(MC, 'server.properties')
    mode = os.stat(path).st_mode & 0o777
    with open(path, encoding='utf-8') as handle:
        lines = handle.read().splitlines()
    out, seen = [], False
    for line in lines:
        if line.startswith(key + '='):
            out.append(f'{key}={value}'); seen = True
        else:
            out.append(line)
    if not seen: out.append(f'{key}={value}')
    tmp = path + '.trials.tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(out) + '\n')
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def remove_property(key):
    path = os.path.join(MC, 'server.properties')
    mode = os.stat(path).st_mode & 0o777
    with open(path, encoding='utf-8') as handle:
        lines = [l for l in handle.read().splitlines() if not l.startswith(key + '=')]
    with open(path + '.trials.tmp', 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
    os.chmod(path + '.trials.tmp', mode)
    os.replace(path + '.trials.tmp', path)


class Rcon:
    def __init__(self, timeout=60):
        props = properties()
        self.timeout = timeout
        self.conn = socket.create_connection(('127.0.0.1', int(props.get('rcon.port', '25575'))), timeout=timeout)
        self.next_id = 10
        if self._packet(3, props.get('rcon.password', ''))[0] == -1:
            raise Stop('rcon authentication failed')

    def _recv(self, size):
        buffer = b''
        while len(buffer) < size:
            chunk = self.conn.recv(size - len(buffer))
            if not chunk: raise ConnectionError('rcon closed')
            buffer += chunk
        return buffer

    def _read(self):
        size = struct.unpack('<i', self._recv(4))[0]
        payload = self._recv(size)
        return struct.unpack('<i', payload[:4])[0], payload[8:-2].decode('utf-8', 'replace')

    def _packet(self, kind, body):
        self.next_id += 1
        data = struct.pack('<ii', self.next_id, kind) + body.encode('utf-8') + b'\0\0'
        self.conn.sendall(struct.pack('<i', len(data)) + data)
        rid, text = self._read()
        # A long answer comes in 4096-byte parts: read on while the last part was full.
        while len(text.encode('utf-8')) >= 4000:
            self.conn.settimeout(0.5)
            try:
                more = self._read()[1]
            except (socket.timeout, OSError):
                break
            finally:
                self.conn.settimeout(self.timeout)
            text += more
            if len(more.encode('utf-8')) < 4000: break
        return rid, text

    def cmd(self, text):
        return self._packet(2, text)[1]

    def close(self):
        try: self.conn.close()
        except OSError: pass


def rcon_try(timeout=60):
    try:
        return Rcon(timeout)
    except (OSError, ConnectionError):
        return None


def server_active():
    return subprocess.run(['systemctl', 'is-active', 'shannon-home.service'], capture_output=True, text=True).stdout.strip() == 'active'


def online_players():
    r = rcon_try()
    if not r: return None
    try:
        text = r.cmd('list')
    except OSError:
        return None          # the server thread is busy (a world being generated): unknown
    finally:
        r.close()
    names = text.split('online:', 1)[1] if 'online:' in text else ''
    return [n.strip() for n in names.split(',') if n.strip()]


def stop_server():
    if not server_active(): return
    for _ in range(20):          # a logout may take a few seconds to show
        players = online_players() or []
        if BODY not in players: break
        time.sleep(3)
    others = [p for p in players if p != BODY]
    if others: raise Stop(f'people are on shannon-home ({", ".join(others)}); not stopping it')
    if BODY in players: raise Stop('the body is still on the server; log it out first')
    out = subprocess.run(['./stop.sh'], cwd=MC, capture_output=True, text=True, timeout=150)
    if out.returncode != 0 or server_active(): raise Stop(f'stop.sh failed: {out.stdout.strip()} {out.stderr.strip()}'[:300])


def start_server():
    out = subprocess.run(['./start.sh'], cwd=MC, capture_output=True, text=True, timeout=120)
    for _ in range(90):
        r = rcon_try(10)
        if r:
            try:
                r.cmd('list'); return
            except OSError:
                pass
            finally:
                r.close()
        time.sleep(2)
    raise Stop(f'the server did not answer RCON after start.sh: {out.stdout.strip()[-200:]} {out.stderr.strip()[-200:]}')


# ---------------------------------------------------------------- world switching

def save_production_state():
    """Remembers the production settings once; a second call keeps the first record (an interrupted batch)."""
    state = load_json(STATE)
    if state: return state
    props = properties()
    with open(os.path.join(MC, 'world-id'), encoding='utf-8') as handle:
        world_id = handle.read().strip()
    level = props.get('level-name', '')
    if level in (LIVE, SCOUT): raise Stop(f'level-name is already {level} but no state.json: fix server.properties by hand')
    stamp = jst_stamp(True)
    os.makedirs(BACKUPS, mode=0o700, exist_ok=True)
    shutil.copy2(os.path.join(MC, 'server.properties'), os.path.join(BACKUPS, f'server.properties.{stamp}'))
    shutil.copy2(os.path.join(MC, 'world-id'), os.path.join(BACKUPS, f'world-id.{stamp}'))
    state = {'levelName': level, 'levelSeed': props.get('level-seed', ''), 'pauseWhenEmpty': props.get('pause-when-empty-seconds'), 'worldId': world_id, 'serverWasActive': server_active(),
             'savedAt': now_iso(), 'backupStamp': stamp}
    save_json(STATE, state)
    os.chmod(STATE, 0o600)
    return state


def write_world_id(value):
    if not re.match(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', value): raise Stop(f'bad world id {value}')
    path = os.path.join(MC, 'world-id')
    with open(path + '.tmp', 'w', encoding='utf-8') as handle:
        handle.write(value + '\n')
    os.replace(path + '.tmp', path)


def clear_trial_dir(name):
    target = os.path.join(MC, name)
    if os.path.islink(target): raise Stop(f'{target} is a link')
    if os.path.exists(target):
        if not os.path.exists(os.path.join(target, MARK)): raise Stop(f'{target} exists and is not a trial world; not touching it')
        shutil.rmtree(target)
    return target


def property_lines(path):
    with open(path, encoding='utf-8') as handle:
        return sorted(l for l in handle.read().splitlines() if l and not l.startswith('#'))


def put_back_properties(state):
    """The saved server.properties byte for byte, when the only differences are ours and the server's date comment."""
    saved = os.path.join(BACKUPS, 'server.properties.' + state['backupStamp'])
    path = os.path.join(MC, 'server.properties')
    if not os.path.exists(saved): return
    if property_lines(saved) != property_lines(path):
        log('restore: server.properties has other changes than ours; kept as is (level-name and level-seed set back)')
        return
    mode = os.stat(path).st_mode & 0o777
    shutil.copyfile(saved, path + '.trials.tmp')
    os.chmod(path + '.trials.tmp', mode)
    os.replace(path + '.trials.tmp', path)


def restore_production(start_again=None):
    state = load_json(STATE)
    if not state:
        log('restore: nothing to restore (no state.json)'); return
    stop_server()
    set_property('level-name', state['levelName'])
    set_property('level-seed', state['levelSeed'])
    if state.get('pauseWhenEmpty') is None: remove_property('pause-when-empty-seconds')
    else: set_property('pause-when-empty-seconds', state['pauseWhenEmpty'])
    put_back_properties(state)
    write_world_id(state['worldId'])
    props = properties()
    ok = props.get('level-name') == state['levelName'] and props.get('level-seed', '') == state['levelSeed']
    if not ok: raise Stop('restore: server.properties does not read back as saved')
    if start_again if start_again is not None else state.get('serverWasActive'): start_server()
    os.replace(STATE, STATE + f'.done-{jst_stamp(True)}')
    log(f'restore: level-name={state["levelName"]} world-id={state["worldId"]} (server {"started" if server_active() else "stopped"})')


# ---------------------------------------------------------------- the production database and the operator CLI

def db():
    return sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=10)


def accepted_last_hour():
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S')
    with db() as c:
        rows = c.execute("SELECT occurred_at FROM operator_audit WHERE event='accepted' AND occurred_at>=? ORDER BY occurred_at", (since,)).fetchall()
    return [r[0] for r in rows]


def wait_rate(need):
    while True:
        rows = accepted_last_hour()
        if len(rows) + need <= RATE_PER_HOUR: return
        oldest = dt.datetime.strptime(rows[len(rows) + need - RATE_PER_HOUR - 1][:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc)
        wait = max(5, (oldest + dt.timedelta(hours=1, seconds=5) - dt.datetime.now(dt.timezone.utc)).total_seconds())
        log(f'rate: {len(rows)} accepted in the last hour; waiting {int(wait)} s for room for {need}')
        time.sleep(min(wait, 600))


def ops(*args, timeout=240):
    env = dict(os.environ, SHANNON_DATABASE_PATH=DB)
    argv = [NODE, '--import', 'tsx', 'services/api/src/opsCli.ts', 'minecraft', args[0], '--operator', OPERATOR, *args[1:]]
    out = subprocess.run(argv, cwd=IOS, env=env, capture_output=True, text=True, timeout=timeout)
    reply = {}
    for line in out.stdout.splitlines():
        m = re.match(r'^(outcome|code|message|taskId|lifecycleId|deadlineAt|budgetYen|operationId): (.*)$', line)
        if m: reply[m.group(1)] = m.group(2)
    reply['exit'] = out.returncode
    if out.returncode and not reply.get('outcome'): reply['stderr'] = out.stderr.strip()[-300:]
    log(f'ops {args[0]}: {reply.get("outcome")} {reply.get("code")} {reply.get("message", "")[:80]}')
    return reply


def task_row(task_id):
    with db() as c:
        row = c.execute('SELECT status, exec_state, pause_reason, goal, created_at, updated_at FROM agent_tasks WHERE task_id=?', (task_id,)).fetchone()
        budget = c.execute('SELECT steps, yen, capped_at FROM fca_task_budget WHERE task_id=?', (task_id,)).fetchone()
    if not row: return None
    return {'status': row[0], 'execState': row[1], 'pauseReason': row[2], 'goal': row[3], 'createdAt': row[4], 'updatedAt': row[5],
            'steps': budget[0] if budget else 0, 'yen': round(budget[1], 2) if budget else 0.0, 'cappedAt': budget[2] if budget else None}


def minecraft_task_active():
    with db() as c:
        rows = c.execute("""SELECT task_id, status FROM agent_tasks WHERE status IN ('queued','starting','running','waiting_approval')
                            AND (capability LIKE '%minecraft%' OR task_kind LIKE '%minecraft%' OR goal LIKE '%マイクラ%' OR goal LIKE '%エンドラ%')""").fetchall()
    return rows


def decisions(task_id):
    """The decisions of a task (fca_task_history rows) with the tools they used."""
    with db() as c:
        rows = c.execute('SELECT entries_json, committed_at, committed_status FROM fca_task_history WHERE task_id=? ORDER BY sequence', (task_id,)).fetchall()
    tools, failed, calls, last_text = {}, 0, 0, ''
    for entries, _, _ in rows:
        try: items = json.loads(entries)
        except ValueError: continue
        for item in items:
            content = item.get('content')
            if not isinstance(content, list): continue
            for part in content:
                if not isinstance(part, dict): continue
                if item.get('role') == 'assistant' and part.get('type') == 'tool_use':
                    name = part.get('name', '?'); tools[name] = tools.get(name, 0) + 1; calls += 1
                elif item.get('role') == 'assistant' and part.get('type') == 'text':
                    last_text = str(part.get('text', ''))[:160]
                elif part.get('type') == 'tool_result' and part.get('is_error'):
                    failed += 1
    top = sorted(tools.items(), key=lambda kv: -kv[1])[:8]
    return {'decisions': len(rows), 'toolCalls': calls, 'failedToolResults': failed, 'topTools': dict(top), 'lastThought': last_text}


# ---------------------------------------------------------------- the api.env model line

def restart_services():
    for name in SERVICES:
        subprocess.run(['sudo', '-n', 'systemctl', 'restart', name], check=True, timeout=120)
        time.sleep(3)
    time.sleep(20)
    states = subprocess.run(['systemctl', 'is-active', *SERVICES], capture_output=True, text=True).stdout.split()
    code = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:4319/v1/state'], capture_output=True, text=True).stdout
    log(f'services: {" ".join(states)} /v1/state={code}')
    if any(s != 'active' for s in states): raise Stop('a service is not active after the restart')


def api_model_in_process():
    pid = subprocess.run(['systemctl', 'show', '-p', 'MainPID', '--value', 'shannon-ios'], capture_output=True, text=True).stdout.strip()
    out = subprocess.run(['sudo', '-n', 'cat', f'/proc/{pid}/environ'], capture_output=True).stdout
    for item in out.split(b'\0'):
        if item.startswith(b'SHANNON_FCA_MODEL='): return item.split(b'=', 1)[1].decode()
    return None


def env_on():
    with open(API_ENV, 'rb') as handle: data = handle.read()
    if any(l.startswith(b'SHANNON_FCA_MODEL=') for l in data.splitlines()): raise Stop('api.env already has SHANNON_FCA_MODEL; stop')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder = os.path.join(ENV_BACKUPS, f'trials-sonnet-{stamp}')
    os.makedirs(folder, mode=0o700)
    shutil.copy2(API_ENV, os.path.join(folder, 'api.env'))
    mode = os.stat(API_ENV).st_mode & 0o777
    if not data.endswith(b'\n'): data += b'\n'
    with open(API_ENV + '.trials.tmp', 'wb') as handle: handle.write(data + MODEL_LINE)
    os.chmod(API_ENV + '.trials.tmp', mode)
    os.replace(API_ENV + '.trials.tmp', API_ENV)
    with open(os.path.join(HERE, 'env-backup-path'), 'w') as handle: handle.write(folder + '\n')
    log(f'env: SHANNON_FCA_MODEL line added (mode {oct(os.stat(API_ENV).st_mode & 0o777)}, backup {folder}/api.env)')
    restart_services()
    log(f'env: API process SHANNON_FCA_MODEL={api_model_in_process()}')


def env_off():
    try:
        with open(os.path.join(HERE, 'env-backup-path')) as handle: folder = handle.read().strip()
    except FileNotFoundError:
        folder = None
    with open(API_ENV, 'rb') as handle: data = handle.read()
    lines = data.splitlines(keepends=True)
    if MODEL_LINE not in lines:
        log('env: no SHANNON_FCA_MODEL line of ours in api.env; nothing to revert')
    else:
        if folder: shutil.copy2(API_ENV, os.path.join(folder, 'api.env.with-sonnet-before-revert'))
        mode = os.stat(API_ENV).st_mode & 0o777
        kept = b''.join(l for l in lines if l != MODEL_LINE)
        with open(API_ENV + '.trials.tmp', 'wb') as handle: handle.write(kept)
        os.chmod(API_ENV + '.trials.tmp', mode)
        os.replace(API_ENV + '.trials.tmp', API_ENV)
        restart_services()
    mode = oct(os.stat(API_ENV).st_mode & 0o777)
    same = None
    if folder and os.path.exists(os.path.join(folder, 'api.env')):
        with open(os.path.join(folder, 'api.env'), 'rb') as handle: same = handle.read() == open(API_ENV, 'rb').read()
    log(f'env: reverted; same as the backup={same} mode={mode} API process SHANNON_FCA_MODEL={api_model_in_process()}')
    if same is False:
        log('env: api.env differs from the backup (changed by someone else during the batch?): keys only below')
        old = {l.split(b'=', 1)[0] for l in open(os.path.join(folder, 'api.env'), 'rb').read().splitlines() if b'=' in l}
        new = {l.split(b'=', 1)[0] for l in open(API_ENV, 'rb').read().splitlines() if b'=' in l}
        log('  added:', sorted(k.decode() for k in new - old), 'removed:', sorted(k.decode() for k in old - new))
    if os.path.exists(os.path.join(HERE, 'env-backup-path')): os.remove(os.path.join(HERE, 'env-backup-path'))


# ---------------------------------------------------------------- scouting a seed

def forceload_area(r, cx, cz, chunk_radius, step=4):
    """Generates the chunks around spawn a few at a time: one forceload of 200+ chunks holds the server thread for minutes."""
    tiles = []
    for x0 in range(cx - chunk_radius, cx + chunk_radius + 1, step):
        for z0 in range(cz - chunk_radius, cz + chunk_radius + 1, step):
            x1, z1 = min(x0 + step - 1, cx + chunk_radius), min(z0 + step - 1, cz + chunk_radius)
            if math.dist(((x0 + x1) / 2, (z0 + z1) / 2), (cx, cz)) > chunk_radius + step: continue
            tiles.append((x0, z0, x1, z1))
    t0 = time.monotonic()
    for n, (x0, z0, x1, z1) in enumerate(tiles):
        r.cmd(f'forceload add {x0 * 16} {z0 * 16} {x1 * 16 + 15} {z1 * 16 + 15}')
        corners = [(x0, z0), (x1, z1), (x0, z1), (x1, z0)]
        for _ in range(120):
            if all('passed' in r.cmd(f'execute if loaded {x * 16} 64 {z * 16}').lower() for x, z in corners): break
            time.sleep(1)
        r.cmd('forceload remove all')
        if n % 10 == 9: log(f'forceload: {n + 1}/{len(tiles)} tiles ({time.monotonic() - t0:.0f} s)')


def locate(r, spawn, kind, what):
    x, y, z = spawn
    text = r.cmd(f'execute positioned {x} {y} {z} run locate {kind} {what}')
    m = re.search(r'at \[(-?\d+), (~|-?\d+), (-?\d+)\] \((\d+) blocks away\)', text)
    if not m: return None
    return {'distance': int(m.group(4)), 'at': [int(m.group(1)), None if m.group(2) == '~' else int(m.group(2)), int(m.group(3))]}


def cmd_scout(args):
    key, seed = args.key, str(args.seed)
    if not re.match(r'^[a-z0-9][a-z0-9-]{0,31}$', key): raise Stop('key: a-z, 0-9 and -, at most 32')
    dest = os.path.join(PRISTINE, key)
    if os.path.exists(dest) and not args.replace and not args.quick: raise Stop(f'{dest} exists (use --replace)')
    if online_players(): raise Stop('someone is on shannon-home; not scouting now')
    save_production_state()
    try:
        stop_server()
        target = clear_trial_dir(SCOUT)
        os.makedirs(target)
        open(os.path.join(target, MARK), 'w').close()
        set_property('level-name', SCOUT)
        set_property('level-seed', seed)
        set_property('pause-when-empty-seconds', '-1')   # an empty server pauses after 60 s and stops generating chunks
        write_world_id(f'trial-scout-{key}')
        log(f'scout {key}: generating seed {seed}')
        start_server()
        r = Rcon()
        r.cmd('save-all flush'); time.sleep(2)
        spawn = world_spawn(target)
        log(f'scout {key}: spawn {spawn}')
        if not args.quick: forceload_area(r, spawn[0] >> 4, spawn[2] >> 4, (args.radius >> 4) + 1)
        found = {}
        for name, kind, what in [('village', 'structure', '#minecraft:village'), ('igloo', 'structure', 'minecraft:igloo'),
                                 ('ruined_portal', 'structure', 'minecraft:ruined_portal'), ('mineshaft', 'structure', '#minecraft:mineshaft'),
                                 ('plains', 'biome', 'minecraft:plains'), ('forest', 'biome', 'minecraft:forest'),
                                 ('snowy_plains', 'biome', 'minecraft:snowy_plains'), ('desert', 'biome', 'minecraft:desert'),
                                 ('badlands', 'biome', 'minecraft:badlands'), ('ocean', 'biome', '#minecraft:is_ocean')]:
            found[name] = locate(r, spawn, kind, what)
        reported_seed = r.cmd('seed')
        r.cmd('save-all flush'); time.sleep(3)
        r.close()
        stop_server()
        if args.quick:
            print(json.dumps({'key': key, 'seed': seed, 'spawn': spawn,
                              **{k: (v or {}).get('distance') for k, v in found.items()}}, ensure_ascii=False))
            return
        scan = scan_world(target, spawn, args.radius)
        facts = {'key': key, 'seed': seed, 'serverSeed': re.sub(r'[^0-9-]', '', reported_seed), 'spawn': spawn, 'radius': args.radius,
                 'locate': found, **scan, 'scoutedAt': now_iso(), 'note': args.note or ''}
        if os.path.exists(dest): shutil.rmtree(dest)
        os.makedirs(dest)
        shutil.copytree(target, os.path.join(dest, 'world'), ignore=shutil.ignore_patterns('session.lock'))
        save_json(os.path.join(dest, 'facts.json'), facts)
        log(f'scout {key}: saved {dest}')
        print(json.dumps(summary_line(facts), ensure_ascii=False))
    finally:
        restore_production(start_again=False if args.keep_stopped else None)


def summary_line(f):
    def d(name, src='locate'):
        v = (f.get(src) or {}).get(name)
        return v['distance'] if v else None
    return {'key': f['key'], 'seed': f['seed'], 'biome': f.get('spawnBiome'), 'village': d('village'), 'igloo': d('igloo'),
            'ruinedPortal': d('ruined_portal'), 'surfaceLava': d('surface_lava', 'nearest'), 'log': d('log', 'nearest'),
            'logs32': f['counts']['logs_within_32'], 'iron48': f['counts']['iron_ore_within_48'], 'coal48': f['counts']['coal_ore_within_48'],
            'sheep': f['animals'].get('sheep', 0), 'nearestSheep': d('sheep', 'nearest'), 'plains': d('plains'), 'snowy': d('snowy_plains')}


def cmd_seedof(args):
    for world in args.worlds:
        try:
            print(world, world_seed(world), world_spawn(world))
        except (OSError, ValueError, KeyError) as error:
            print(world, 'unreadable', error)


# ---------------------------------------------------------------- one trial

def count_items(r, item):
    text = r.cmd(f'clear {BODY} {item} 0')
    m = re.search(r'Found (\d+)', text)
    return int(m.group(1)) if m else 0


def body_state(r):
    dim = r.cmd(f'data get entity {BODY} Dimension')
    pos = r.cmd(f'data get entity {BODY} Pos')
    health = r.cmd(f'data get entity {BODY} Health')
    respawn = r.cmd(f'data get entity {BODY} respawn')
    deaths = r.cmd(f'scoreboard players get {BODY} trial_deaths')
    m = re.search(r'"([a-z_:]+)"', dim)
    p = [float(v) for v in re.findall(r'(-?\d+(?:\.\d+)?)d', pos)][:3]
    h = re.search(r'(-?\d+(?:\.\d+)?)f', health)
    dn = re.search(r'has (\d+) \[', deaths)
    return {'dimension': m.group(1) if m else None, 'pos': [round(v, 1) for v in p] if p else None, 'health': float(h.group(1)) if h else None,
            'respawnSet': 'has the following entity data' in respawn, 'deaths': int(dn.group(1)) if dn else 0}


def check_milestones(section, counts, state, latched, maxima, elapsed):
    """Latches each milestone the first time it holds; returns whether every end milestone is latched."""
    for m in section['milestones']:
        name = m['name']
        if name in latched: continue
        ok = False
        if 'dimension' in m:
            ok = state.get('dimension') == m['dimension']
        elif 'all' in m:
            ok = all(counts.get(i, 0) >= 1 for i in m['all'])
        elif 'any' in m:
            ok = sum(counts.get(i, 0) for i in m['any']) >= m.get('count', 1) or (m.get('orRespawn') and state.get('respawnSet'))
        elif 'dropFrom' in m:
            top = maxima.get(m['dropFrom'], 0)
            ok = top >= m['after'] and top - counts.get(m['dropFrom'], 0) >= m['drop']
        if ok: latched[name] = round(elapsed, 1)
    return all(m['name'] in latched for m in section['milestones'] if m.get('end'))


def end_seconds(section, latched):
    return max(latched[m['name']] for m in section['milestones'] if m.get('end'))


def tracked_items(section):
    items = set()
    for m in section['milestones']:
        items.update(m.get('any', []))
        items.update(m.get('all', []))
        if 'dropFrom' in m: items.add(m['dropFrom'])
    return sorted(items)


def variant_start(variant, facts):
    """[x, z] to start at instead of the world spawn: `offset` blocks short of a located structure, on the way from spawn."""
    if not variant.get('near'): return None
    target = ((facts.get('locate') or {}).get(variant['near']) or {}).get('at')
    if not target: raise Stop(f'no {variant["near"]} located for {variant.get("world")}')
    sx, _, sz = facts['spawn']
    tx, tz = target[0], target[2]
    d = math.dist((sx, sz), (tx, tz)) or 1
    k = max(0.0, (d - variant.get('offset', 48)) / d)
    return [round(sx + (tx - sx) * k), round(sz + (tz - sz) * k)]


def setup_body(r, section, start_at):
    r.cmd(f'clear {BODY}')
    for item, count in section['start'].get('give', {}).items():
        r.cmd(f'give {BODY} {item} {count}')
    for slot, item in section['start'].get('wear', {}).items():
        r.cmd(f'item replace entity {BODY} {slot} with {item}')
    if section['start'].get('hold'):
        r.cmd(f'item replace entity {BODY} weapon.mainhand with {section["start"]["hold"]}')
    if start_at:   # on the ground there (spreadplayers finds the top block; the chunks generate as she arrives)
        r.cmd(f'spreadplayers {start_at[0]} {start_at[1]} 0 6 false {BODY}')
    r.cmd(f'effect clear {BODY}')
    r.cmd(f'effect give {BODY} minecraft:instant_health 1 10 true')
    r.cmd(f'effect give {BODY} minecraft:saturation 1 10 true')
    r.cmd(f'time set {section["start"].get("time", 0)}')
    r.cmd('weather clear')
    r.cmd(f'scoreboard players set {BODY} trial_deaths 0')


def wait_body_online(seconds=90):
    for _ in range(seconds // 3):
        if BODY in (online_players() or []): return True
        time.sleep(3)
    return False


def run_trial(section, seed_key, batch, cfg, dry_run):
    trial_id = f'{batch}-s{section["id"]}-{seed_key}'
    variant = (load_json(os.path.join(HERE, 'seeds.json'), {}).get('variants') or {}).get(seed_key, {})
    world_key = variant.get('world', seed_key)
    pristine = os.path.join(PRISTINE, world_key, 'world')
    facts = load_json(os.path.join(PRISTINE, world_key, 'facts.json'), {})
    start_at = variant_start(variant, facts)
    result = {'trial': trial_id, 'batch': batch, 'section': section['id'], 'sectionName': section['name'], 'seedKey': seed_key,
              'seed': facts.get('seed'), 'targetSeconds': section['targetSeconds'], 'limitMinutes': section['limitMinutes'],
              'capYen': cfg['trialCapYen'], 'startedAt': now_iso(), 'ok': False, 'reason': None, 'seconds': None, 'milestones': {}}
    if not os.path.exists(pristine):
        result['reason'] = 'no_pristine_world'; return result
    stop_server()
    target = clear_trial_dir(LIVE)
    shutil.copytree(pristine, target)
    open(os.path.join(target, MARK), 'w').close()
    set_property('level-name', LIVE)
    set_property('pause-when-empty-seconds', '-1')   # the clock must run between logout and the next login too
    world_id = f'trial-{seed_key}-s{section["id"]}-{jst_stamp(True)}'
    write_world_id(world_id)
    result['worldId'] = world_id
    start_server()
    r = Rcon()
    r.cmd('scoreboard objectives add trial_deaths deathCount')
    r.cmd(f'time set {section["start"].get("time", 0)}')
    r.close()
    if dry_run:
        result['reason'] = 'dry_run'; return result
    wait_rate(4)
    login = ops('login')
    if login.get('outcome') != 'accepted' or not wait_body_online():
        result['reason'] = f'login_failed:{login.get("code")}'; return result
    time.sleep(8)
    r = Rcon()
    setup_body(r, section, start_at)
    time.sleep(4)
    result['startState'] = body_state(r)
    result['startAt'] = start_at or 'spawn'
    r.close()
    request = ops('request', '--max-minutes', str(section['limitMinutes'] + 2), '--budget-yen', str(cfg['trialCapYen']), GOAL)
    task_id = request.get('taskId')
    if request.get('outcome') != 'accepted' or not task_id:
        result['reason'] = f'request_refused:{request.get("code")}'
        ops('logout'); return result
    t0 = time.monotonic()
    result['taskId'] = task_id
    row = task_row(task_id)
    result['goalChars'] = len(row['goal']) if row else None
    result['goalOk'] = bool(row) and row['goal'] == GOAL and len(row['goal']) == 13
    log(f'trial {trial_id}: task {task_id} goal={result["goalChars"]} chars ok={result["goalOk"]}')
    latched, maxima, first_seen, last = {}, {}, {}, {}
    items = tracked_items(section)
    reason = None
    while True:
        elapsed = time.monotonic() - t0
        try:
            r = Rcon()
            counts = {i: count_items(r, i) for i in items}
            state = body_state(r)
            r.close()
        except (OSError, ConnectionError) as error:
            counts, state = {}, {}
            log(f'trial {trial_id}: rcon {error}')
        for i, n in counts.items():
            maxima[i] = max(maxima.get(i, 0), n)
            if n and i not in first_seen: first_seen[i] = round(elapsed, 1)
        done = check_milestones(section, counts, state, latched, maxima, elapsed)
        row = task_row(task_id) or {}
        last = {'counts': counts, 'state': state, 'row': row}
        if done: reason = 'reached'; break
        if state.get('deaths'): reason = 'died'; break
        if row.get('status') in TERMINAL: reason = f'task_{row["status"]}:{row.get("pauseReason") or row.get("execState")}'; break
        if row.get('yen', 0) >= cfg['trialCapYen'] - 1: reason = 'budget'; break
        if elapsed >= section['limitMinutes'] * 60: reason = 'time_limit'; break
        time.sleep(cfg['pollSeconds'])
    elapsed = time.monotonic() - t0
    log(f'trial {trial_id}: {reason} at {elapsed:.0f} s; milestones {latched}')
    row = task_row(task_id) or {}
    if row.get('status') not in TERMINAL:
        ops('cancel', task_id)
        for _ in range(30):
            row = task_row(task_id) or {}
            if row.get('status') in TERMINAL: break
            time.sleep(2)
        if row.get('status') not in TERMINAL:
            wait_rate(2)
            ops('release')
    time.sleep(3)
    row = task_row(task_id) or {}
    result.update({'ok': reason == 'reached', 'reason': reason, 'seconds': end_seconds(section, latched) if reason == 'reached' else None,
                   'elapsed': round(elapsed, 1), 'milestones': latched, 'firstSeen': first_seen, 'maxCounts': maxima,
                   'missing': [m['name'] for m in section['milestones'] if m.get('end') and m['name'] not in latched],
                   'final': last.get('state'), 'yen': row.get('yen'), 'budgetSteps': row.get('steps'),
                   'taskStatus': row.get('status'), 'pauseReason': row.get('pauseReason'), **decisions(task_id)})
    wait_rate(1)
    ops('logout')
    for _ in range(20):
        if BODY not in (online_players() or []): break
        time.sleep(3)
    return result


# ---------------------------------------------------------------- a batch and its report

def config():
    return load_json(os.path.join(HERE, 'sections.json'))


def cmd_run(args):
    cfg = config()
    sections = {str(s['id']): s for s in cfg['sections']}
    chosen = [sections[k] for k in (args.sections.split(',') if args.sections else sections)]
    only_seeds = set(args.seeds.split(',')) if args.seeds else None
    plan = [(s, k) for s in chosen for k in s['seeds'] if not only_seeds or k in only_seeds]
    if args.limit: plan = plan[:args.limit]
    batch = args.batch or jst_stamp()
    folder = os.path.join(RESULTS, batch)
    os.makedirs(folder, exist_ok=True)
    log(f'batch {batch}: {len(plan)} trials: {", ".join(f"S{s["id"]}/{k}" for s, k in plan)}')
    busy = minecraft_task_active()
    if busy: raise Stop(f'a Minecraft task is still active: {busy}')
    if subprocess.run(['pgrep', '-f', 'minecraft-campaign-live-probe'], capture_output=True).returncode == 0: raise Stop('a lab probe is running')
    if online_players(): raise Stop('someone (or the body) is on shannon-home; log out first')
    spent, results, env_changed = 0.0, [], False
    save_production_state()
    try:
        if args.model == 'sonnet' and not args.dry_run:
            env_on(); env_changed = True
        for section, seed_key in plan:
            if spent + cfg['trialCapYen'] > cfg['batchCapYen']:
                log(f'batch: {spent:.0f} yen spent; the next trial could pass {cfg["batchCapYen"]} yen: stopping'); break
            result = run_trial(section, seed_key, batch, cfg, args.dry_run)
            spent += result.get('yen') or 0
            result['batchYenAfter'] = round(spent, 2)
            results.append(result)
            save_json(os.path.join(folder, f'{result["trial"]}.json'), result)
            with open(os.path.join(RESULTS, 'history.jsonl'), 'a', encoding='utf-8') as handle:
                handle.write(json.dumps(result, ensure_ascii=False) + '\n')
            log(f'trial {result["trial"]}: ok={result["ok"]} reason={result["reason"]} s={result.get("seconds")} '
                f'decisions={result.get("decisions")} yen={result.get("yen")} (batch {spent:.0f})')
            if result['reason'] and result['reason'].startswith(('login_failed', 'request_refused', 'no_pristine')) and not args.keep_going:
                log('batch: stopping after a setup failure'); break
    except Stop as error:
        log(f'batch: stopped: {error}')
    finally:
        try:
            if online_players(): ops('logout'); time.sleep(10)
        except Exception as error:   # noqa: BLE001 - the restore below must still run
            log(f'batch: logout at the end failed: {error}')
        restore_production()
        if env_changed: env_off()
    write_report(batch)


def previous_results(before_batch):
    """The latest earlier result of each (section, seed)."""
    out = {}
    path = os.path.join(RESULTS, 'history.jsonl')
    if not os.path.exists(path): return out
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            try: r = json.loads(line)
            except ValueError: continue
            if r.get('batch', '') >= before_batch or r.get('reason') == 'dry_run': continue
            out[(r['section'], r['seedKey'])] = r
    return out


def fmt_s(v):
    return '—' if v is None else f'{v:.0f}'


def write_report(batch):
    folder = os.path.join(RESULTS, batch)
    rows = [load_json(os.path.join(folder, n)) for n in sorted(os.listdir(folder)) if n.endswith('.json') and n.startswith(batch)]
    prev = previous_results(batch)
    lines = [f'# 区間タイムアタック {batch}', '',
             '| 区間 | 種 | 結果 | 秒（目標） | 前回 | 差 | 判断 | 費用 | 理由・足りない物 |', '|---|---|---|---|---|---|---|---|---|']
    table = []
    for r in rows:
        p = prev.get((r['section'], r['seedKey']))
        delta = None
        if r.get('seconds') is not None and p and p.get('seconds') is not None: delta = round(r['seconds'] - p['seconds'], 1)
        verdict = '—' if delta is None else ('速くなった' if delta < -5 else '遅くなった' if delta > 5 else '同じ')
        why = r.get('reason') or ''
        if r.get('missing'): why += '（無い: ' + '・'.join(r['missing']) + '）'
        lines.append(f'| S{r["section"]} {r["sectionName"]} | {r["seedKey"]} | {"達成" if r.get("ok") else "未達"} | {fmt_s(r.get("seconds"))}（{r["targetSeconds"]}） '
                     f'| {fmt_s(p.get("seconds")) if p else "—"} | {"" if delta is None else f"{delta:+.0f} {verdict}"} | {r.get("decisions", "—")} '
                     f'| ¥{r.get("yen") or 0:.0f} | {why} |')
        table.append({**{k: r.get(k) for k in ('trial', 'section', 'sectionName', 'seedKey', 'ok', 'seconds', 'targetSeconds', 'decisions', 'yen', 'reason', 'missing', 'milestones')},
                      'previous': {k: p.get(k) for k in ('trial', 'seconds', 'decisions', 'yen', 'reason')} if p else None, 'deltaSeconds': delta, 'verdict': verdict})
    lines += ['', f'合計 ¥{sum((r.get("yen") or 0) for r in rows):.0f}・{len(rows)} 区間・達成 {sum(1 for r in rows if r.get("ok"))}', '']
    lines.append('## 節目（依頼からの秒）')
    for r in rows:
        ms = '、'.join(f'{k} {v:.0f}' for k, v in sorted((r.get('milestones') or {}).items(), key=lambda kv: kv[1]))
        lines.append(f'- S{r["section"]}/{r["seedKey"]}: {ms or "なし"}；道具 {r.get("toolCalls", "—")} 回・失敗 {r.get("failedToolResults", "—")}')
    text = '\n'.join(lines) + '\n'
    with open(os.path.join(folder, 'report.md'), 'w', encoding='utf-8') as handle: handle.write(text)
    save_json(os.path.join(folder, 'report.json'), {'batch': batch, 'rows': table})
    print(text)


def cmd_report(args):
    batches = sorted(n for n in os.listdir(RESULTS) if os.path.isdir(os.path.join(RESULTS, n)))
    if not batches: raise Stop('no results yet')
    write_report(args.batch or batches[-1])


def on_term(signum, frame):
    raise Stop(f'signal {signum}')


def main(argv):
    signal.signal(signal.SIGTERM, on_term)   # a kill still runs the restore in the finally blocks
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('scout'); p.add_argument('--key', required=True); p.add_argument('--seed', required=True)
    p.add_argument('--radius', type=int, default=96); p.add_argument('--note'); p.add_argument('--replace', action='store_true')
    p.add_argument('--keep-stopped', action='store_true')
    p.add_argument('--quick', action='store_true', help='locate only: no chunks generated, nothing saved')
    p = sub.add_parser('seedof'); p.add_argument('worlds', nargs='+')
    p = sub.add_parser('run'); p.add_argument('--sections'); p.add_argument('--seeds'); p.add_argument('--batch')
    p.add_argument('--model', choices=['sonnet', 'current'], default='sonnet'); p.add_argument('--dry-run', action='store_true')
    p.add_argument('--limit', type=int); p.add_argument('--keep-going', action='store_true')
    p = sub.add_parser('report'); p.add_argument('--batch')
    sub.add_parser('restore')
    p = sub.add_parser('env'); p.add_argument('what', choices=['on', 'off', 'status'])
    args = parser.parse_args(argv)
    try:
        if args.cmd == 'scout': cmd_scout(args)
        elif args.cmd == 'seedof': cmd_seedof(args)
        elif args.cmd == 'run': cmd_run(args)
        elif args.cmd == 'report': cmd_report(args)
        elif args.cmd == 'restore': restore_production()
        elif args.what == 'on': env_on()
        elif args.what == 'off': env_off()
        else: log(f'env: API process SHANNON_FCA_MODEL={api_model_in_process()}')
    except Stop as error:
        log(f'stopped: {error}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
