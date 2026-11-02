#!/usr/bin/env python3
"""Seed scouting for the Minebot dragon run (README.md in this directory, "シードの下調べ").

Starts throw-away 1.21.11 lab servers (the VM lab template: Fabric launcher, no mods), one per seed, asks vanilla /locate and
`execute if biome` what the world looks like around spawn, and writes one JSON line per seed. Standard library only
(python3 -I seedscan.py ...). Never touches shannon-home: servers live under ~/.cache/minebot-lab/seedscan, on loopback.

  scan   --random N | --seeds a,b,c | --seeds-file F   phase A: village, ruined portal, outpost, the Nether side (fortress,
                                                       bastion, warped forest), the three first-ring strongholds (biome above,
                                                       monument beside, ocean on the straight way), spawn biome
  rank   [--top 12] [files...]                         score the phase A lines and print the table
  deep   --seeds a,b [--key K]                         phase B: chunks around spawn (surface lava, trees, animals), the village
                                                       (beds, chests by loot table, crops), the ruined portal, the nearest stronghold
                                                       (its 12 frames, the room, the ground above), the Nether (arrival, fortress,
                                                       blaze spawners and where to stand, a warped forest edge); the world is kept
  publish --key K [--labworld] [--dest DIR]            pristine/K/{world,facts.json,sites.json} for trials.py (and the lab ground)

Where it runs: the VM needs the lab slot (lab-slot.sh); the PC's WSL needs HOME=/home/azureuser (lab-wsl.sh) so the paths match.
"""
import argparse
import concurrent.futures
import datetime as dt
import importlib.util
import json
import math
import os
import random
import re
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser('~')
TEMPLATE = os.environ.get('SEEDSCAN_TEMPLATE') or os.path.join(HOME, 'minecraft', '1.21.11-fabric-test')
ROOT = os.environ.get('SEEDSCAN_ROOT') or os.path.join(HOME, '.cache', 'minebot-lab', 'seedscan')
OUT = os.environ.get('SEEDSCAN_OUT') or os.path.join(HOME, '.cache', 'minebot-lab', 'seedscan-out')
JAVA = os.environ.get('SEEDSCAN_JAVA') or 'java'
GAME_PORT_BASE = 25570         # the lab range 25570-25599; RCON = game port + 1000 (loopback only)
OVERWORLD, NETHER, END = 'minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'

OVERWORLD_BIOMES = [
    'plains', 'sunflower_plains', 'forest', 'flower_forest', 'birch_forest', 'old_growth_birch_forest', 'dark_forest', 'taiga',
    'old_growth_pine_taiga', 'old_growth_spruce_taiga', 'snowy_plains', 'snowy_taiga', 'savanna', 'savanna_plateau', 'desert', 'swamp',
    'mangrove_swamp', 'jungle', 'sparse_jungle', 'bamboo_jungle', 'badlands', 'eroded_badlands', 'wooded_badlands', 'meadow', 'cherry_grove',
    'windswept_hills', 'windswept_gravelly_hills', 'windswept_forest', 'windswept_savanna', 'beach', 'snowy_beach', 'stony_shore', 'river',
    'frozen_river', 'grove', 'snowy_slopes', 'frozen_peaks', 'jagged_peaks', 'stony_peaks', 'ice_spikes', 'mushroom_fields', 'pale_garden',
    'ocean', 'deep_ocean', 'warm_ocean', 'lukewarm_ocean', 'deep_lukewarm_ocean', 'cold_ocean', 'deep_cold_ocean', 'frozen_ocean',
    'deep_frozen_ocean']
# for a body that walks: where a start is easy, middling, or a bad place to be (a decision of ours, written down here)
SPAWN_GOOD = {'plains', 'sunflower_plains', 'forest', 'flower_forest', 'birch_forest', 'old_growth_birch_forest', 'taiga', 'savanna',
              'meadow', 'cherry_grove', 'dark_forest', 'old_growth_pine_taiga', 'old_growth_spruce_taiga'}
SPAWN_OK = {'desert', 'snowy_plains', 'snowy_taiga', 'savanna_plateau', 'windswept_hills', 'windswept_forest', 'windswept_savanna',
            'windswept_gravelly_hills', 'swamp', 'badlands', 'wooded_badlands', 'eroded_badlands', 'sparse_jungle', 'beach', 'snowy_beach',
            'pale_garden', 'stony_shore', 'river', 'frozen_river'}
SPAWN_BAD = {'ocean', 'deep_ocean', 'warm_ocean', 'lukewarm_ocean', 'deep_lukewarm_ocean', 'cold_ocean', 'deep_cold_ocean', 'frozen_ocean',
             'deep_frozen_ocean', 'frozen_peaks', 'jagged_peaks', 'stony_peaks', 'ice_spikes', 'mushroom_fields', 'jungle', 'bamboo_jungle',
             'mangrove_swamp', 'grove', 'snowy_slopes'}


def log(*parts):
    print(dt.datetime.now().strftime('%H:%M:%S'), *parts, flush=True)


def load_trials():
    """trials.py (NBT and region readers, scan_world) by path: python -I does not put this directory on sys.path."""
    spec = importlib.util.spec_from_file_location('trials', os.path.join(HERE, 'trials.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- RCON

class Rcon:
    def __init__(self, port, password, timeout=300):
        self.timeout = timeout
        self.conn = socket.create_connection(('127.0.0.1', port), timeout=timeout)
        self.next_id = 10
        if self._packet(3, password)[0] == -1:
            raise ConnectionError('rcon authentication failed')

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
        while len(text.encode('utf-8')) >= 4000:        # a long answer comes in 4096-byte parts
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


# ---------------------------------------------------------------- a throw-away lab server

def port_free(port):
    with socket.socket() as probe:
        probe.settimeout(0.2)
        return probe.connect_ex(('127.0.0.1', port)) != 0


class Lab:
    """One lab server directory: links to the template's libraries and server jar, its own .fabric copy, world, RCON."""

    def __init__(self, label, seed, slot, heap='1G', cores=2, root=ROOT, template=TEMPLATE, world_from=None, difficulty='peaceful', monsters=False,
                 view=3, simulation=2, max_players=2):
        self.label, self.seed, self.slot = label, str(seed), slot
        self.view, self.simulation, self.max_players = view, simulation, max_players       # a scan sees little; the rig's server is the production's (10 and 8)
        self.dir = os.path.join(root, label)
        self.template, self.heap, self.cores, self.world_from = template, heap, cores, world_from
        self.difficulty, self.monsters = difficulty, monsters       # a scan is peaceful and quiet; a smoke test is the production's normal
        self.port, self.rcon_port = GAME_PORT_BASE + slot, GAME_PORT_BASE + 1000 + slot
        self.password = secrets.token_hex(12)
        self.proc = None
        self.log_path = os.path.join(self.dir, 'logs', 'latest.log')

    def prepare(self):
        if not port_free(self.port) or not port_free(self.rcon_port): raise RuntimeError(f'port {self.port}/{self.rcon_port} in use')
        os.makedirs(self.dir, exist_ok=True)
        for name in ('libraries', 'versions', 'fabric-server-launch.jar'):
            link = os.path.join(self.dir, name)
            if not os.path.lexists(link): os.symlink(os.path.join(self.template, name), link)
        if not os.path.exists(os.path.join(self.dir, '.fabric')):
            shutil.copytree(os.path.join(self.template, '.fabric'), os.path.join(self.dir, '.fabric'), symlinks=True)
        os.makedirs(os.path.join(self.dir, 'mods'), exist_ok=True)
        with open(os.path.join(self.dir, 'eula.txt'), 'w') as handle: handle.write('eula=true\n')
        if self.world_from and not os.path.exists(os.path.join(self.dir, 'world')):
            shutil.copytree(self.world_from, os.path.join(self.dir, 'world'), ignore=shutil.ignore_patterns('session.lock'))
        props = ['server-ip=127.0.0.1', 'online-mode=false', f'server-port={self.port}', 'enable-rcon=true', f'rcon.port={self.rcon_port}',
                 f'rcon.password={self.password}', 'broadcast-rcon-to-ops=false', 'enforce-secure-profile=false', 'spawn-protection=0',
                 'allow-flight=true', f'view-distance={self.view}', f'simulation-distance={self.simulation}', f'max-players={self.max_players}', 'level-name=world',
                 'level-type=minecraft:normal', f'level-seed={self.seed}', 'generate-structures=true', f'difficulty={self.difficulty}',
                 'gamemode=survival', 'enable-command-block=false', 'max-tick-time=-1', 'sync-chunk-writes=false',
                 'pause-when-empty-seconds=-1', 'motd=seedscan', f'spawn-monsters={"true" if self.monsters else "false"}']
        with open(os.path.join(self.dir, 'server.properties'), 'w') as handle: handle.write('\n'.join(props) + '\n')
        os.chmod(os.path.join(self.dir, 'server.properties'), 0o600)

    def start(self):
        self.prepare()
        argv = ['nice', '-n', '10', JAVA, '-Xms256M', f'-Xmx{self.heap}', f'-XX:ActiveProcessorCount={self.cores}',
                *os.environ.get('SEEDSCAN_JVM', '').split(), '-jar', 'fabric-server-launch.jar', 'nogui']
        out = open(os.path.join(self.dir, 'console.log'), 'ab')
        self.proc = subprocess.Popen(argv, cwd=self.dir, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)

    def wait_ready(self, timeout=240):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None: raise RuntimeError(f'server exited {self.proc.returncode}')
            try:
                with open(self.log_path, encoding='utf-8', errors='replace') as handle:
                    if 'Done (' in handle.read(): break
            except FileNotFoundError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError('server did not report Done')
        while time.monotonic() < deadline:
            try:
                return Rcon(self.rcon_port, self.password)
            except (OSError, ConnectionError):
                time.sleep(0.5)
        raise RuntimeError('rcon did not answer')

    def stop(self, remove=True):
        if self.proc and self.proc.poll() is None:
            try:
                r = Rcon(self.rcon_port, self.password, timeout=60)
                r.cmd('save-all flush'); r.cmd('stop'); r.close()
            except (OSError, ConnectionError):
                pass
            try:
                self.proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.proc.kill(); self.proc.wait()
        if remove and os.path.isdir(self.dir) and os.path.abspath(self.dir).startswith(os.path.abspath(ROOT) + os.sep):
            shutil.rmtree(self.dir, ignore_errors=True)


# ---------------------------------------------------------------- asking the server

# a tag query prints "The nearest #minecraft:village (minecraft:village_plains) is at [16, ~, 160] (160 blocks away)"
NEAREST = re.compile(r'The nearest (\S+)(?: \((\S+)\))? is at \[(-?\d+), (~|-?\d+), (-?\d+)\] \((\d+) blocks away\)')


def locate(r, kind, what, at, dim=OVERWORLD):
    x, y, z = at
    text = r.cmd(f'execute in {dim} positioned {x} {y} {z} run locate {kind} {what}')
    m = NEAREST.search(text)
    if not m:
        if 'Could not find' not in text: raise RuntimeError(f'locate {what}: {text[:120]}')
        return None
    return {'id': m.group(2) or m.group(1), 'd': int(m.group(6)),
            'at': [int(m.group(3)), None if m.group(4) == '~' else int(m.group(4)), int(m.group(5))]}


def near_biome(r, what, x, z, y=63, dim=OVERWORLD, here=5):
    """Is (x, z) inside `what` (a biome or #tag)? /locate biome finds the nearest cell of it; a cell is 4 blocks wide, so <= 5 is "here"."""
    hit = locate(r, 'biome', what, (x, y, z), dim)
    return hit is not None and hit['d'] <= here


def biome_name(r, x, y, z, dim=OVERWORLD):
    """The name of the biome at a point: its chunk is force-loaded (spawn is already generated) and every biome is asked."""
    r.cmd(f'execute in {dim} run forceload add {x} {z}')
    try:
        for name in OVERWORLD_BIOMES:
            text = ''
            for _ in range(40):
                text = r.cmd(f'execute in {dim} positioned {x} {y} {z} if biome ~ ~ ~ minecraft:{name}')
                if 'not loaded' not in text: break
                time.sleep(0.25)
            if 'passed' in text.lower(): return name
    finally:
        r.cmd(f'execute in {dim} run forceload remove {x} {z}')
    return None


def route_cells(r, a, b, step=96):
    """Biome cells on the straight way a -> b that are sea: a body cannot walk those (rivers it can, so they are not counted)."""
    length = math.dist(a, b)
    n = max(1, round(length / step))
    sea, first_sea = 0, None
    for i in range(n + 1):
        x, z = round(a[0] + (b[0] - a[0]) * i / n), round(a[1] + (b[1] - a[1]) * i / n)
        if near_biome(r, '#minecraft:is_ocean', x, z):
            sea += 1
            if first_sea is None: first_sea = round(length * i / n)
    return {'cells': n + 1, 'sea': sea, 'firstSeaAt': first_sea}


def first_ring(r):
    """The three strongholds of the first ring (1,408-2,688 blocks from the origin): /locate from points around it."""
    found = {}
    for degrees in range(0, 360, 45):
        for radius in (1900, 2500):
            x, z = round(radius * math.cos(math.radians(degrees))), round(radius * math.sin(math.radians(degrees)))
            hit = locate(r, 'structure', 'minecraft:stronghold', (x, 64, z))
            if hit: found[(hit['at'][0], hit['at'][2])] = hit
    return [v for v in found.values() if math.hypot(v['at'][0], v['at'][2]) <= 3000]


def read_spawn(lab, trials):
    path = os.path.join(lab.dir, 'world')
    for _ in range(40):
        try:
            spawn = trials.world_spawn(path)
            if spawn: return spawn
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.5)
    raise RuntimeError('no spawn in level.dat')


# ---------------------------------------------------------------- phase A

LAND_RUINED_PORTALS = ['minecraft:ruined_portal', 'minecraft:ruined_portal_desert', 'minecraft:ruined_portal_jungle',
                       'minecraft:ruined_portal_mountain', 'minecraft:ruined_portal_swamp']   # the ocean one lies under water


def nearest_of(hits):
    hits = [h for h in hits if h]
    return min(hits, key=lambda h: h['d']) if hits else None


def phase_a(lab, r, trials, gates):
    """A1 (every seed): spawn, village, ruined portal, outpost, the Nether side, the first ring of strongholds. A2 (when the
    provisional score reaches gates['deep_min']): the sea on the way to the village and the strongholds, the sea above them, monuments."""
    t0 = time.monotonic()
    out = {'seed': lab.seed}
    r.cmd('save-all flush')
    sx, sy, sz = read_spawn(lab, trials)
    out['spawn'] = [sx, sy, sz]
    seed_reply = r.cmd('seed')
    out['serverSeed'] = re.sub(r'[^0-9-]', '', seed_reply.split('[', 1)[-1]) if '[' in seed_reply else seed_reply
    spawn_biome = biome_name(r, sx, sy, sz)
    out['spawnBiome'] = spawn_biome
    out['spawnClass'] = 'good' if spawn_biome in SPAWN_GOOD else 'ok' if spawn_biome in SPAWN_OK else 'bad'

    def done(reason=None):
        if reason: out['reject'] = reason
        out['secs'] = round(time.monotonic() - t0, 1)
        return out

    if out['spawnClass'] == 'bad' and gates.get('village_max') is not None:
        return done(f'spawn_biome:{spawn_biome}')
    at = (sx, sy, sz)
    village = locate(r, 'structure', '#minecraft:village', at)
    out['village'] = village
    if gates.get('village_max') is not None and (village is None or village['d'] > gates['village_max']):
        return done(f'village:{village["d"] if village else "none"}')
    out['ruinedPortal'] = nearest_of([locate(r, 'structure', name, at) for name in LAND_RUINED_PORTALS])
    out['outpost'] = locate(r, 'structure', 'minecraft:pillager_outpost', at)
    out['mineshaft'] = locate(r, 'structure', '#minecraft:mineshaft', at)
    nx, nz = sx // 8, sz // 8
    nat = (nx, 70, nz)
    out['netherAt'] = [nx, nz]
    out['fortress'] = locate(r, 'structure', 'minecraft:fortress', nat, NETHER)
    out['bastion'] = locate(r, 'structure', 'minecraft:bastion_remnant', nat, NETHER)
    out['warped'] = locate(r, 'biome', 'minecraft:warped_forest', nat, NETHER)
    out['crimson'] = locate(r, 'biome', 'minecraft:crimson_forest', nat, NETHER)
    holds = []
    for hit in sorted(first_ring(r), key=lambda h: math.dist((h['at'][0], h['at'][2]), (sx, sz))):
        x, z = hit['at'][0], hit['at'][2]
        holds.append({'at': [x, z], 'd': round(math.dist((x, z), (sx, sz))), 'fromOrigin': round(math.hypot(x, z))})
    out['strongholds'] = holds
    if score(out, optimistic=True)[0] < gates.get('deep_min', 0):
        return done()
    # A2: only for the seeds that already look good
    out['villageRoute'] = route_cells(r, (sx, sz), (village['at'][0], village['at'][2]), 48)
    for item in holds[:2]:
        x, z = item['at']
        item['seaAbove'] = any(near_biome(r, '#minecraft:is_ocean', x + dx, z + dz) for dx, dz in ((0, 0), (64, 0), (-64, 0), (0, 64), (0, -64)))
        item['monument'] = (locate(r, 'structure', 'minecraft:monument', (x, 64, z)) or {}).get('d')
        item['route'] = route_cells(r, (sx, sz), (x, z), 96)
    out['deepA'] = True
    return done()


def append_line(path, value, lock=threading.Lock()):
    with lock, open(path, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + '\n')


def scan_one(seed, slot, args, trials, out_path, keep_if):
    label = f's{slot}-{seed}'.replace('-', 'n', 1) if str(seed).startswith('-') else f's{slot}-{seed}'
    lab = Lab(label, seed, slot, heap=args.heap, cores=args.cores)
    t0 = time.monotonic()
    result = {'seed': str(seed)}
    keep = False
    try:
        shutil.rmtree(lab.dir, ignore_errors=True)
        lab.start()
        r = lab.wait_ready()
        result['startSecs'] = round(time.monotonic() - t0, 1)
        try:
            result = phase_a(lab, r, trials, {'village_max': None if args.no_gates else args.village_max, 'deep_min': args.deep_min})
            result['startSecs'] = round(time.monotonic() - t0 - result.get('secs', 0), 1)
        finally:
            r.close()
        keep = bool(keep_if and not result.get('reject') and keep_if(result))
        result['kept'] = lab.dir if keep else None
    except Exception as error:      # noqa: BLE001 - one bad seed must not stop the batch
        result['error'] = f'{type(error).__name__}: {error}'[:300]
    finally:
        lab.stop(remove=not keep)
    result['totalSecs'] = round(time.monotonic() - t0, 1)
    append_line(out_path, result)
    return result


def cmd_scan(args):
    trials = load_trials()
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(ROOT, exist_ok=True)
    if args.seeds: seeds = [s.strip() for s in args.seeds.split(',') if s.strip()]
    elif args.seeds_file:
        with open(args.seeds_file) as handle: seeds = [l.split()[0] for l in handle if l.strip() and not l.startswith('#')]
    else:
        rng = random.Random(args.master)
        seeds = [str(rng.getrandbits(64) - (1 << 63)) for _ in range(args.random)]
        seeds = seeds[args.skip:]
    for seed in seeds:
        if not re.match(r'^-?\d{1,20}$', seed): raise SystemExit(f'bad seed {seed}')
    out_path = os.path.join(OUT, f'phaseA-{args.tag}.jsonl')
    done = set()
    if os.path.exists(out_path):
        with open(out_path, encoding='utf-8') as handle:
            for line in handle:
                try: done.add(str(json.loads(line)['seed']))
                except (ValueError, KeyError): pass
    seeds = [s for s in seeds if s not in done]
    log(f'scan {args.tag}: {len(seeds)} seeds, {args.workers} workers, village <= {args.village_max}, out {out_path}')
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    slots = list(range(args.workers))
    free = threading.Semaphore(args.workers)
    lock = threading.Lock()
    counts = {'done': 0, 'kept': 0, 'error': 0}
    started = time.monotonic()

    def worker(seed):
        if stop.is_set(): return
        with lock: slot = slots.pop(0)
        try:
            res = scan_one(seed, slot + args.slot_base, args, trials, out_path, None)
        finally:
            with lock: slots.append(slot)
        with lock:
            counts['done'] += 1
            if res.get('error'): counts['error'] += 1
            n = counts['done']
        if n % 10 == 0 or not res.get('reject'):
            v = (res.get('village') or {}).get('d')
            log(f'[{n}/{len(seeds)}] {time.monotonic() - started:.0f}s seed={seed} reject={res.get("reject")} village={v} err={res.get("error")} t={res.get("totalSecs")}')

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(worker, seeds))
    except KeyboardInterrupt:
        stop.set()
    log(f'scan {args.tag}: finished {counts} in {time.monotonic() - started:.0f}s')


# ---------------------------------------------------------------- scoring

def pts(value, table):
    """First row whose limit is not exceeded: [(limit, points), ...]; None (not found) scores 0."""
    if value is None: return 0
    for limit, p in table:
        if value <= limit: return p
    return 0


def stronghold_points(row, optimistic=False, profile='film'):
    """(points, the first-ring stronghold that earned them). One under the sea or beside a monument earns nothing. After A2 only the
    strongholds A2 measured count; before it, with optimistic, the sea on the way counts as none."""
    best, which = 0, None
    holds = row.get('strongholds') or []
    if profile == 'film' and holds:
        # an eye of ender points at the NEAREST stronghold from where it is thrown, so that one is the target: if it lies under the sea or by a
        # monument, a land stronghold farther off does not help the run (she is led to the sea)
        holds = [min(holds, key=lambda s: s['d'])]
    for s in holds:
        if s.get('seaAbove') or (s.get('monument') is not None and s['monument'] < 150):
            if profile == 'film': which = s
            continue
        if row.get('deepA') and 'route' not in s: continue
        if 'route' in s: sea = s['route'].get('sea', 9)
        else: sea = 0 if optimistic else 9
        if profile == 'film':       # up to 20: how far she walks to it, whether the way is land, how far down the room is
            p = pts(s.get('dRoom', s['d']), [(1200, 12), (1600, 10), (2000, 7), (2400, 4), (2800, 2)])
            p += 6 if sea == 0 else 3 if sea <= 2 else 0
            depth = s.get('depth')
            p += 1 if depth is None else 2 if depth <= 70 else 1 if depth <= 110 else 0
        else:
            p = pts(s['d'], [(1600, 15), (2000, 12), (2400, 8), (2800, 4)])
            p += 10 if sea == 0 else 5 if sea <= 2 else 0
            if s.get('depth') is not None: p -= 0 if s['depth'] <= 70 else 3 if s['depth'] <= 110 else 8      # digging down from the ground above the room
        if p > best: best, which = p, s
    return best, which


def terrain_points(row, optimistic=False):
    """Up to 15 for a spawn whose first minutes are safe: no sea or ice underfoot, no dense forest, no steep land, no lava at the door."""
    h = row.get('hazards')
    if not h: return 12 if optimistic else 8        # not measured (phase B reads the generated ground)
    p = 15
    wf, ice, sea = h.get('waterFrac') or 0, h.get('iceFrac') or 0, h.get('seaNearest')
    p -= 8 if wf > 0.35 else 4 if wf > 0.15 else 2 if wf > 0.05 else 0
    if sea is not None: p -= 3 if sea < 60 else 1 if sea < 120 else 0
    p -= 5 if ice > 0.03 else 0
    p -= 5 if (h.get('frozenBiomeFrac') or 0) > 0.3 else 0
    forest = 4 if (h.get('denseForestFrac') or 0) > 0.5 else 0
    if (row.get('logs32') or 0) > 350: forest = max(forest, 4) + (1 if forest else 3)
    p -= forest
    relief = h.get('relief')
    if relief is not None: p -= 4 if relief > 45 else 2 if relief > 30 else 0
    lava = row.get('surfaceLava')
    if lava is not None and lava < 12: p -= 2
    return max(0, p)


def score_film(row, optimistic=False):
    """The filming run: from nothing, no supply, one go to the dragon. Heavy on how fast she is in the Nether (a village's bed and food,
    obsidian at hand, a safe spawn), on the fortress, the warped forest and a stronghold under land. 0-100, every term printed."""
    parts = {}
    v = row.get('village') or {}
    route = row.get('villageRoute')
    village = pts(v.get('d'), [(60, 18), (100, 17), (150, 14), (250, 9), (350, 4)]) - (8 if (route.get('sea', 0) if route else 0) else 0)
    vf = row.get('villageFacts')
    if vf:
        if vf['beds'] < 3: village -= 4
        if vf['cropTotal'] < 20 and vf['livestock'] < 6: village -= 5
    parts['village'] = max(0, village)
    rp = (row.get('ruinedPortal') or {}).get('d')
    lava = row.get('surfaceLava')
    parts['obsidian'] = max(pts(rp, [(120, 14), (250, 10), (400, 5)]), pts(lava, [(40, 14), (70, 11), (100, 7)]))
    parts['diamond'] = pts(row.get('nearestDiamond'), [(48, 3), (96, 1)]) if 'nearestDiamond' in row else 2      # 2 = not measured yet (none within 96 m: 0)
    parts['terrain'] = terrain_points(row, optimistic)
    parts['fortress'] = pts((row.get('fortress') or {}).get('d'), [(120, 15), (180, 13), (250, 10), (350, 6), (500, 3)])
    parts['warped'] = pts((row.get('warped') or {}).get('d'), [(100, 10), (200, 8), (350, 5), (500, 2)])
    parts['bastion'] = pts((row.get('bastion') or {}).get('d'), [(200, 3), (400, 1)])
    parts['stronghold'] = stronghold_points(row, optimistic, 'film')[0]
    parts['spawn'] = {'good': 2, 'ok': 1}.get(row.get('spawnClass'), 0)
    parts['outpost'] = -5 if (row.get('outpost') or {}).get('d', 9999) < 200 else 0
    return sum(parts.values()), parts


def score(row, optimistic=False, profile='film'):
    """profile 'film' (default): the filming run, score_film. 'general': the first table of 2026-11-02 (kept to reproduce it)."""
    if profile == 'film': return score_film(row, optimistic)
    parts = {}
    v = row.get('village') or {}
    route = row.get('villageRoute')
    sea_to_village = route.get('sea', 0) if route else 0
    parts['village'] = pts(v.get('d'), [(80, 30), (150, 26), (250, 20), (350, 10)]) - (15 if sea_to_village else 0)
    vf = row.get('villageFacts')
    if vf:      # phase B: a bed to set her spawn and sleep in, and something to eat (crops, or animals about the village and spawn)
        if vf['beds'] < 3: parts['village'] -= 6
        if vf['cropTotal'] < 20 and vf['livestock'] < 6: parts['village'] -= 8
    rp = (row.get('ruinedPortal') or {}).get('d')
    lava = row.get('surfaceLava')
    parts['obsidian'] = max(pts(rp, [(120, 15), (250, 10), (400, 5)]), pts(lava, [(40, 15), (70, 12), (100, 8)]))
    nether = pts((row.get('fortress') or {}).get('d'), [(150, 12), (250, 9), (400, 5)]) \
        + pts((row.get('bastion') or {}).get('d'), [(200, 5), (400, 2)]) + pts((row.get('warped') or {}).get('d'), [(150, 8), (300, 5), (500, 2)])
    parts['nether'] = min(25, nether)
    parts['stronghold'] = stronghold_points(row, optimistic, 'general')[0]
    parts['spawn'] = {'good': 5, 'ok': 3}.get(row.get('spawnClass'), 0)
    parts['outpost'] = -5 if (row.get('outpost') or {}).get('d', 9999) < 200 else 0
    return sum(parts.values()), parts


def load_rows(paths):
    rows = {}
    for path in paths:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                try: row = json.loads(line)
                except ValueError: continue
                old = rows.get(str(row['seed']))
                if old and not old.get('reject') and not old.get('error') and (row.get('reject') or row.get('error')): continue   # keep the complete line
                rows[str(row['seed'])] = row
    return list(rows.values())


def fmt_d(hit, key='d'):
    return '—' if not hit else str(hit[key])


def nearest_stronghold(row):
    """The first-ring stronghold an eye thrown at spawn points to, and whether it can be used (not under the sea, no monument beside it)."""
    holds = row.get('strongholds') or []
    s = min(holds, key=lambda h: h['d']) if holds else None
    if not s: return None, 'none'
    if s.get('seaAbove'): return s, 'sea'
    if s.get('monument') is not None and s['monument'] < 150: return s, 'monument'
    return s, None


def table_line(row, total, parts):
    v = row.get('village') or {}
    strong, bad = nearest_stronghold(row)
    strong = strong or {}
    flag = {'sea': '海の下', 'monument': '海底神殿のそば', None: '陸'}[bad] if bad != 'none' else '—'
    return (f'| {row["seed"]} | {total} | {row.get("spawnBiome")} ({row["spawn"][0]}, {row["spawn"][2]}) | '
            f'{v.get("id", "—").replace("minecraft:village_", "")} {fmt_d(v)} | {fmt_d(row.get("ruinedPortal"))} | '
            f'{fmt_d(row.get("fortress"))} / {fmt_d(row.get("bastion"))} / {fmt_d(row.get("warped"))} | '
            f'{strong.get("dRoom", strong.get("d", "—"))} ({strong.get("at", ["—"])[0]}, {strong.get("at", ["", "—"])[1]}) {flag} 道の海{(strong.get("route") or {}).get("sea", "—")} | '
            f'{"・".join(f"{k}{p}" for k, p in parts.items())} |')


def deep_results():
    """{seed: (key, deep result)} of the deep-<key>.json files in the out directory."""
    out = {}
    for name in sorted(os.listdir(OUT)):
        if name.startswith('deep-') and name.endswith('.json'):
            try:
                with open(os.path.join(OUT, name), encoding='utf-8') as handle: d = json.load(handle)
                out[str(d['seed'])] = (name[5:-5], d)
            except (OSError, ValueError, KeyError):
                pass
    return out


def cmd_rank(args):
    paths = args.files or [os.path.join(OUT, n) for n in sorted(os.listdir(OUT)) if n.startswith('phaseA-') and n.endswith('.jsonl')]
    rows = load_rows(paths)
    deep = deep_results()
    scanned = [r for r in rows if not r.get('error')]
    kept = [r for r in scanned if not r.get('reject') and r.get('strongholds') is not None]
    ranked = []
    for r in kept:
        key, d = deep.get(str(r['seed']), (None, None))
        row = final_row(r, d) if d else r
        ranked.append((score(row, optimistic=not d, profile=args.profile), row, key))
    ranked.sort(key=lambda t: -t[0][0])
    print(f'seeds {len(rows)}（失敗 {len(rows) - len(scanned)}、足切り {len(scanned) - len(kept)}、採点 {len(kept)}、うち世界まで読んだもの {sum(1 for t in ranked if t[2])}）。採点：{args.profile}'
          f'（世界を読んでいないものは、読んでいない項目を良い方に数える）')
    print('| シード（名前） | 点 | スポーン | 村（種類 距離） | 廃ポータル | ネザー（要塞/砦/歪んだ森）m | ストロングホールド（距離 陸/海 道の海） | 内訳 |')
    print('|---|---|---|---|---|---|---|---|')
    for (total, parts), row, key in ranked[:args.top]:
        print(table_line(row, total, parts).replace(f'| {row["seed"]} |', f'| {row["seed"]}{f"（{key}）" if key else ""} |', 1))


# ---------------------------------------------------------------- phase B: what the generator really built there

DIM_DIRS = {OVERWORLD: '', NETHER: 'DIM-1', END: 'DIM1'}
AIR = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'}
HOT = ('minecraft:lava', 'minecraft:fire', 'minecraft:soul_fire', 'minecraft:magma_block')
NETHER_FLOORS = {'minecraft:netherrack', 'minecraft:crimson_nylium', 'minecraft:warped_nylium', 'minecraft:basalt', 'minecraft:smooth_basalt',
                 'minecraft:blackstone', 'minecraft:soul_soil', 'minecraft:gravel', 'minecraft:nether_bricks', 'minecraft:red_nether_bricks',
                 'minecraft:glowstone', 'minecraft:nether_gold_ore', 'minecraft:nether_quartz_ore', 'minecraft:polished_blackstone_bricks'}


def force_area(r, dim, x0, z0, x1, z1, step=4, wait=300):
    """Generates the chunks of a block box: tiles of step x step chunks, each loaded in full before the next is asked for."""
    cx0, cz0, cx1, cz1 = x0 >> 4, z0 >> 4, x1 >> 4, z1 >> 4
    for tx in range(cx0, cx1 + 1, step):
        for tz in range(cz0, cz1 + 1, step):
            ex, ez = min(tx + step - 1, cx1), min(tz + step - 1, cz1)
            r.cmd(f'execute in {dim} run forceload add {tx * 16} {tz * 16} {ex * 16 + 15} {ez * 16 + 15}')
            deadline = time.monotonic() + wait
            while time.monotonic() < deadline:
                if all('passed' in r.cmd(f'execute in {dim} if loaded {x * 16} 64 {z * 16}').lower()
                       for x, z in ((tx, tz), (ex, ez), (tx, ez), (ex, tz))): break
                time.sleep(0.5)
            else:
                raise RuntimeError(f'force_area {dim}: tile {tx},{tz} not loaded in {wait} s')
            r.cmd(f'execute in {dim} run forceload remove all')


class Chunks:
    """The full chunks of one dimension inside a block box, read from the region files (after save-all flush)."""

    def __init__(self, trials, world, dim, x0, z0, x1, z1):
        self.t, self.map = trials, {}
        base = os.path.join(world, DIM_DIRS[dim], 'region') if DIM_DIRS[dim] else os.path.join(world, 'region')
        cx0, cz0, cx1, cz1 = x0 >> 4, z0 >> 4, x1 >> 4, z1 >> 4
        for rx in range(cx0 >> 5, (cx1 >> 5) + 1):
            for rz in range(cz0 >> 5, (cz1 >> 5) + 1):
                path = os.path.join(base, f'r.{rx}.{rz}.mca')
                if not os.path.exists(path): continue
                for chunk in trials.region_chunks(path):
                    cx, cz = chunk.get('xPos'), chunk.get('zPos')
                    if cx is None or not (cx0 <= cx <= cx1 and cz0 <= cz <= cz1): continue
                    if not str(chunk.get('Status', '')).endswith('full'): continue
                    chunk['_sections'] = {s.get('Y'): s for s in chunk.get('sections', [])}
                    self.map[(cx, cz)] = chunk

    def unpack(self, section):
        if '_pal' not in section:
            states = section.get('block_states') or {}
            palette = states.get('palette', [])
            data = states.get('data')
            section['_pal'] = palette
            section['_idx'] = None if (not data or len(palette) <= 1) else self.t.unpack_indices(data, max(4, (len(palette) - 1).bit_length()))
        return section['_pal'], section['_idx']

    def state(self, x, y, z):
        """The palette entry ({'Name', 'Properties'}) at a block, or None when its chunk or section is not here."""
        chunk = self.map.get((x >> 4, z >> 4))
        section = chunk['_sections'].get(y >> 4) if chunk else None
        if section is None: return None
        palette, idx = self.unpack(section)
        if not palette: return None
        return palette[0 if idx is None else idx[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]]

    def name(self, x, y, z):
        s = self.state(x, y, z)
        return s.get('Name') if s else None

    def find(self, match):
        """(palette entry, x, y, z) of every block whose name satisfies `match` (sections of one block are skipped)."""
        for (cx, cz), chunk in self.map.items():
            for sy, section in chunk['_sections'].items():
                palette, idx = self.unpack(section)
                if idx is None: continue
                hit = {i for i, p in enumerate(palette) if match(p.get('Name', ''))}
                if not hit: continue
                for pos, p in enumerate(idx):
                    if p in hit: yield palette[p], cx * 16 + (pos & 15), sy * 16 + (pos >> 8), cz * 16 + ((pos >> 4) & 15)

    def block_entities(self, ids):
        for chunk in self.map.values():
            for be in chunk.get('block_entities', []):
                if be.get('id') in ids: yield be

    def structure_starts(self, name):
        for chunk in self.map.values():
            start = ((chunk.get('structures') or {}).get('starts') or {}).get(name)
            if start and start.get('id') != 'INVALID': yield start

    def surface(self, x, z, skip=None):
        """(y, block name) of the highest block that is not air at a column; `skip(name)` true passes over leaves, logs, plants (the ground)."""
        chunk = self.map.get((x >> 4, z >> 4))
        if not chunk: return None
        order = chunk.setdefault('_order', sorted(chunk['_sections'], reverse=True))
        for sy in order:
            section = chunk['_sections'][sy]
            palette, idx = self.unpack(section)
            if idx is None and (palette[0].get('Name') in AIR if palette else True): continue
            for ly in range(15, -1, -1):
                name = palette[0 if idx is None else idx[(ly << 8) | ((z & 15) << 4) | (x & 15)]].get('Name')
                if name in AIR or (skip and skip(name)): continue
                return sy * 16 + ly, name
        return None

    def biome(self, x, y, z):
        """The biome name at a block's 4x4x4 cell, or None."""
        chunk = self.map.get((x >> 4, z >> 4))
        section = chunk['_sections'].get(y >> 4) if chunk else None
        if section is None: return None
        return self.t.section_biome_at(section, x & 15, y & 15, z & 15)


def short(name):
    return (name or '').replace('minecraft:', '')


WET = {'minecraft:water', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:bubble_column'}
ICE = {'minecraft:ice', 'minecraft:packed_ice', 'minecraft:blue_ice', 'minecraft:frosted_ice', 'minecraft:powder_snow'}
DENSE_FOREST = {'minecraft:dark_forest', 'minecraft:old_growth_birch_forest', 'minecraft:old_growth_pine_taiga', 'minecraft:old_growth_spruce_taiga',
                'minecraft:jungle', 'minecraft:bamboo_jungle', 'minecraft:sparse_jungle', 'minecraft:mangrove_swamp'}


def not_ground(name):
    """Blocks a body walks through or over without standing on them: the crown of a tree, plants, a layer of snow."""
    return (name.endswith('_leaves') or name.endswith('_log') or name.endswith('_wood') or name in {
        'minecraft:vine', 'minecraft:snow', 'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern', 'minecraft:leaf_litter',
        'minecraft:bush', 'minecraft:dead_bush', 'minecraft:sweet_berry_bush', 'minecraft:cactus', 'minecraft:bamboo', 'minecraft:sugar_cane', 'minecraft:brown_mushroom',
        'minecraft:red_mushroom', 'minecraft:firefly_bush', 'minecraft:cherry_leaves', 'minecraft:azalea', 'minecraft:flowering_azalea', 'minecraft:moss_carpet',
        'minecraft:pink_petals', 'minecraft:wildflowers'} or name.endswith('_flower') or name in {'minecraft:dandelion', 'minecraft:poppy', 'minecraft:azure_bluet', 'minecraft:cornflower'})


def spawn_hazards(ch, spawn, radius=64, step=4):
    """What the first minutes at spawn run into, read from the generated ground within `radius` blocks: water and ice underfoot, the biome
    cells (dense forest, snow and ice), the lie of the land (a hill and a gully)."""
    sx, sy, sz = spawn
    total = water = ice = 0
    ground, biomes = [], {}
    for x in range(sx - radius, sx + radius + 1, step):
        for z in range(sz - radius, sz + radius + 1, step):
            if (x - sx) ** 2 + (z - sz) ** 2 > radius ** 2: continue
            top = ch.surface(x, z)
            if not top: continue
            total += 1
            if top[1] in WET: water += 1
            elif top[1] in ICE: ice += 1
            else:
                g = ch.surface(x, z, not_ground)
                if g: ground.append(g[0])
            b = ch.biome(x, top[0], z)
            if b: biomes[b] = biomes.get(b, 0) + 1
    cells = sum(biomes.values()) or 1
    ground.sort()
    lo, hi = (ground[int(len(ground) * 0.05)], ground[int(len(ground) * 0.95) - 1]) if len(ground) > 20 else (None, None)
    return {'radius': radius, 'columns': total, 'waterFrac': round(water / total, 3) if total else None, 'iceFrac': round(ice / total, 3) if total else None,
            'denseForestFrac': round(sum(n for b, n in biomes.items() if b in DENSE_FOREST) / cells, 3),
            'frozenBiomeFrac': round(sum(n for b, n in biomes.items() if 'frozen' in b or 'ice' in b or 'snowy' in b) / cells, 3),
            'relief': (hi - lo) if lo is not None else None, 'groundLow': lo, 'groundHigh': hi,
            'biomes': {short(b): round(n / cells, 2) for b, n in sorted(biomes.items(), key=lambda kv: -kv[1])[:5]}}


def stage_spawn_area(lab, r, trials, row, radius=96):
    sx, sy, sz = row['spawn']
    force_area(r, OVERWORLD, sx - radius - 16, sz - radius - 16, sx + radius + 16, sz + radius + 16)
    r.cmd('save-all flush'); time.sleep(3)
    world = os.path.join(lab.dir, 'world')
    scan = trials.scan_world(world, row['spawn'], radius)
    near = scan['nearest']
    d = lambda k: near.get(k, {}).get('distance')
    ch = Chunks(trials, world, OVERWORLD, sx - 80, sz - 80, sx + 80, sz + 80)
    hazards = spawn_hazards(ch, row['spawn'])
    sea = locate(r, 'biome', '#minecraft:is_ocean', (sx, sy, sz))
    hazards['seaNearest'] = sea['d'] if sea else None
    return {'radius': radius, 'surfaceLava': d('surface_lava'), 'surfaceLavaAt': near.get('surface_lava', {}).get('at'),
            'nearestLog': d('log'), 'logs32': scan['counts']['logs_within_32'], 'iron48': scan['counts']['iron_ore_within_48'],
            'coal48': scan['counts']['coal_ore_within_48'], 'deepLavaChunks': scan['counts']['deep_lava_chunks'],
            'nearestDiamond': d('diamond_ore'),
            'animals': scan['animals'], 'nearestSheep': d('sheep'), 'nearestCow': d('cow'), 'nearestPig': d('pig'),
            'spawnBiome': scan['spawnBiome'], 'hazards': hazards, 'raw': scan}


def stage_village(lab, r, trials, row, half=96):
    vx, vz = row['village']['at'][0], row['village']['at'][2]
    box = (vx - half, vz - half, vx + half, vz + half)
    force_area(r, OVERWORLD, *box)
    r.cmd('save-all flush'); time.sleep(3)
    world = os.path.join(lab.dir, 'world')
    ch = Chunks(trials, world, OVERWORLD, *box)
    crops = {'wheat': 0, 'carrots': 0, 'potatoes': 0, 'beetroots': 0}
    beds, others = 0, {'hay_block': 0, 'composter': 0, 'bell': 0, 'farmland': 0, 'furnace': 0, 'smoker': 0, 'blast_furnace': 0, 'crafting_table': 0}
    for p, x, y, z in ch.find(lambda n: n.endswith('_bed') or short(n) in crops or short(n) in others):
        n = short(p['Name'])
        if n.endswith('_bed'):
            if (p.get('Properties') or {}).get('part') == 'head': beds += 1
        elif n in crops: crops[n] += 1
        else: others[n] += 1
    loot = {}
    for be in ch.block_entities({'minecraft:chest', 'minecraft:barrel', 'minecraft:trapped_chest'}):
        if abs(be['x'] - vx) > half or abs(be['z'] - vz) > half or be['y'] < 50: continue
        table = be.get('LootTable')
        key = short(table).replace('chests/village/village_', '').replace('chests/', '') if table else ('(opened or placed) ' + short(be['id']))
        loot[key] = loot.get(key, 0) + 1
    animals = {}
    ent_dir = os.path.join(world, 'entities')
    for rx in range((vx - half) >> 9, ((vx + half) >> 9) + 1):
        for rz in range((vz - half) >> 9, ((vz + half) >> 9) + 1):
            path = os.path.join(ent_dir, f'r.{rx}.{rz}.mca')
            if not os.path.exists(path): continue
            for chunk in trials.region_chunks(path):
                for e in chunk.get('Entities', []):
                    kind = short(e.get('id'))
                    pos = e.get('Pos') or [0, 0, 0]
                    if kind in ('cow', 'pig', 'sheep', 'chicken', 'villager', 'iron_golem', 'cat', 'horse') and abs(pos[0] - vx) <= half and abs(pos[2] - vz) <= half:
                        animals[kind] = animals.get(kind, 0) + 1
    return {'at': [vx, vz], 'beds': beds, 'crops': crops, 'cropTotal': sum(crops.values()), 'chestsByLoot': loot, 'chests': sum(loot.values()),
            **others, 'animals': animals, 'chunks': len(ch.map)}


def stage_ruined_portal(lab, r, trials, row, half=40):
    px, pz = row['ruinedPortal']['at'][0], row['ruinedPortal']['at'][2]
    box = (px - half, pz - half, px + half, pz + half)
    force_area(r, OVERWORLD, *box)
    r.cmd('save-all flush'); time.sleep(2)
    ch = Chunks(trials, os.path.join(lab.dir, 'world'), OVERWORLD, *box)
    counts, nearest_lava = {}, None
    for p, x, y, z in ch.find(lambda n: short(n) in ('lava', 'obsidian', 'crying_obsidian', 'magma_block', 'netherrack', 'gold_block')):
        n = short(p['Name'])
        if y < 40 and n == 'lava': continue
        counts[n] = counts.get(n, 0) + 1
        if n == 'lava':
            d = math.dist((x, z), (px, pz))
            if nearest_lava is None or d < nearest_lava[0]: nearest_lava = (round(d), [x, y, z])
    loot = [short(be.get('LootTable')) for be in ch.block_entities({'minecraft:chest'}) if abs(be['x'] - px) <= half and abs(be['z'] - pz) <= half and be.get('LootTable')]
    return {'id': row['ruinedPortal']['id'], 'at': [px, pz], 'blocks': counts, 'nearestLava': nearest_lava, 'chestLoot': loot}


def stronghold_facts(lab, r, trials, row, hold, half=130):
    """Generate the stronghold around its start; read its pieces and the 12 portal frames; the ground above the portal room."""
    x, z = hold['at']
    box = (x - half, z - half, x + half, z + half)
    force_area(r, OVERWORLD, *box)
    r.cmd('save-all flush'); time.sleep(3)
    ch = Chunks(trials, os.path.join(lab.dir, 'world'), OVERWORLD, *box)
    frames = [{'x': bx, 'y': by, 'z': bz, 'facing': (p.get('Properties') or {}).get('facing'), 'eye': (p.get('Properties') or {}).get('eye') == 'true'}
              for p, bx, by, bz in ch.find(lambda n: n == 'minecraft:end_portal_frame')]
    out = {'start': [x, z], 'chunks': len(ch.map), 'frames': frames}
    pieces = []
    for start in ch.structure_starts('minecraft:stronghold'):
        pieces = [{'id': c.get('id'), 'bb': c.get('BB')} for c in start.get('Children', [])]
    out['pieces'] = len(pieces)
    if frames:
        cx = round(sum(f['x'] for f in frames) / len(frames), 1)
        cz = round(sum(f['z'] for f in frames) / len(frames), 1)
        cy = min(f['y'] for f in frames)
        out['portalCenter'] = [cx, cy, cz]
        out['eyesAlreadyIn'] = sum(1 for f in frames if f['eye'])
        top = ch.surface(round(cx), round(cz))
        out['surfaceAbove'] = {'y': top[0], 'block': top[1]} if top else None
        out['depth'] = (top[0] - cy) if top else None
        wet = {'minecraft:water', 'minecraft:ice', 'minecraft:packed_ice', 'minecraft:blue_ice', 'minecraft:kelp', 'minecraft:seagrass', 'minecraft:tall_seagrass'}
        out['seaAbove'] = bool(top and top[1] in wet)
        rooms = [p for p in pieces if p['bb'] and p['bb'][0] <= cx <= p['bb'][3] and p['bb'][2] <= cz <= p['bb'][5] and p['bb'][1] <= cy <= p['bb'][4]]
        out['portalRoomPiece'] = rooms[0] if rooms else None
        out['fromSpawn'] = round(math.dist((cx, cz), (row['spawn'][0], row['spawn'][2])))
        out['fromStart'] = round(math.dist((cx, cz), (x, z)))
        if rooms:       # where she can stand in the room: solid floor, two air above, 3-6.5 blocks from the portal centre, no lava beside
            bb = rooms[0]['bb']
            lava = {(lx, ly, lz) for _, lx, ly, lz in ch.find(lambda n: n == 'minecraft:lava') if bb[0] - 3 <= lx <= bb[3] + 3 and bb[2] - 3 <= lz <= bb[5] + 3}
            best = None
            for sx_ in range(bb[0], bb[3] + 1):
                for sz_ in range(bb[2], bb[5] + 1):
                    d = math.dist((sx_, sz_), (cx, cz))
                    if d < 3 or d > 6.5: continue
                    for sy_ in range(bb[1] + 1, bb[4]):
                        below = ch.name(sx_, sy_ - 1, sz_)
                        if below is None or below in AIR or below in ('minecraft:lava', 'minecraft:end_portal_frame', 'minecraft:water'): continue
                        if ch.name(sx_, sy_, sz_) not in AIR or ch.name(sx_, sy_ + 1, sz_) not in AIR: continue
                        if any((sx_ + dx, sy_ + dy, sz_ + dz) in lava for dx in (-1, 0, 1) for dz in (-1, 0, 1) for dy in (-1, 0, 1)): continue
                        s = abs(sy_ - cy) * 2 + abs(d - 4)
                        if best is None or s < best[0]: best = (s, [sx_, sy_, sz_])
            out['stand'] = best[1] if best else None
    return out


def lava_grid(ch, cells=None):
    """The set of (x, y, z) holding lava inside the loaded chunks (for a clearance test around a standing place)."""
    return {(x, y, z) for _, x, y, z in ch.find(lambda n: n == 'minecraft:lava')}


def stand_cells(ch, around, radius, lava, floors=NETHER_FLOORS, clear=4, y_range=(33, 118)):
    """Standing places (floor block under, 3 air above, no lava or fire within `clear`) nearest to `around`, as (distance, [x, y, z])."""
    ax, az = around
    out = []
    for x in range(ax - radius, ax + radius + 1):
        for z in range(az - radius, az + radius + 1):
            for y in range(y_range[0], y_range[1]):
                if ch.name(x, y - 1, z) not in floors: continue
                if any(ch.name(x, y + k, z) not in AIR for k in range(3)): continue
                if any((x + dx, y + dy, z + dz) in lava for dx in range(-clear, clear + 1) for dz in range(-clear, clear + 1) for dy in range(-2, 3)): continue
                out.append((round(math.dist((x, z), (ax, az)), 1), [x, y, z]))
    return sorted(out)


def stage_nether(lab, r, trials, row):
    sx, sz = row['netherAt']
    world = os.path.join(lab.dir, 'world')
    out = {'arrivalAt': [sx, sz]}
    # the place she would step out of the portal: a standing place near spawn / 8
    box = (sx - 64, sz - 64, sx + 64, sz + 64)
    force_area(r, NETHER, *box)
    r.cmd('save-all flush'); time.sleep(3)
    ch = Chunks(trials, world, NETHER, *box)
    lava = lava_grid(ch)
    cells = stand_cells(ch, (sx, sz), 48, lava, clear=6)
    out['arrival'] = cells[0][1] if cells else None
    out['arrivalOffset'] = cells[0][0] if cells else None
    # the nearest fortress, all of it, and the blaze spawners in it
    fort = row.get('fortress')
    if fort:
        fx, fz = fort['at'][0], fort['at'][2]
        box = (fx - 112, fz - 112, fx + 112, fz + 112)
        force_area(r, NETHER, *box)
        r.cmd('save-all flush'); time.sleep(3)
        fc = Chunks(trials, world, NETHER, *box)
        starts = list(fc.structure_starts('minecraft:fortress'))
        pieces = [{'id': c.get('id'), 'bb': c.get('BB')} for s in starts for c in s.get('Children', [])]
        spawners = []
        for be in fc.block_entities({'minecraft:mob_spawner'}):
            ent = ((be.get('SpawnData') or {}).get('entity') or {}).get('id')
            spawners.append({'at': [be['x'], be['y'], be['z']], 'mob': short(ent)})
        flava = lava_grid(fc)
        for s in spawners:
            if s['mob'] != 'blaze': continue
            sxx, syy, szz = s['at']
            best = None
            for x in range(sxx - 9, sxx + 10):
                for z in range(szz - 9, szz + 10):
                    for y in range(syy - 6, syy + 5):
                        if fc.name(x, y - 1, z) not in ('minecraft:nether_bricks', 'minecraft:red_nether_bricks'): continue
                        if any(fc.name(x, y + k, z) not in AIR for k in range(3)): continue
                        d = math.dist((x, y, z), (sxx, syy, szz))
                        if d < 3 or d > 9 or any((x + dx, y + dy, z + dz) in flava for dx in (-2, 0, 2) for dz in (-2, 0, 2) for dy in (-1, 0, 1)): continue
                        score_ = abs(d - 5)
                        if best is None or score_ < best[0]: best = (score_, [x, y, z], round(d, 1))
            s['standAt'] = best[1] if best else None
            s['standDistance'] = best[2] if best else None
            s['fromArrival'] = round(math.dist((sxx, szz), tuple(out['arrival'][::2]))) if out['arrival'] else None
        out['fortress'] = {'at': [fx, fz], 'd': fort['d'], 'pieces': len(pieces), 'spawners': spawners,
                           'blazeSpawners': sum(1 for s in spawners if s['mob'] == 'blaze'), 'chunks': len(fc.map)}
    # a standing place at the edge of the nearest warped forest
    warped = row.get('warped')
    if warped:
        wx, wz = warped['at'][0], warped['at'][2]
        box = (wx - 80, wz - 80, wx + 80, wz + 80)
        force_area(r, NETHER, *box)
        r.cmd('save-all flush'); time.sleep(2)
        wc = Chunks(trials, world, NETHER, *box)
        wlava = lava_grid(wc)
        nylium = [c for c in stand_cells(wc, (wx, wz), 72, wlava, floors={'minecraft:warped_nylium'}, clear=3)]
        out['warped'] = {'at': [wx, wz], 'd': warped['d'], 'stand': nylium[0][1] if nylium else None}
    return out


def stage_end_note():
    return {'note': 'the End is the same island in every seed (pillars differ); see README "エンド"'}


STAGES = ('spawn', 'village', 'portal', 'stronghold', 'nether')


def nearest_usable_stronghold(row):
    s, bad = nearest_stronghold(row)
    if bad: raise RuntimeError(f'the nearest first-ring stronghold ({bad}) cannot be walked to: an eye thrown at spawn points to it')
    return s


def deep_one(seed, row, slot, args, trials, out_dir, key=None):
    key = key or args.key or f'd{abs(int(seed)) % 10 ** 6}'
    lab = Lab(f'deep-{key}', seed, slot, heap=args.heap, cores=args.cores)
    result = {'key': key, 'seed': str(seed), 'spawn': row['spawn'], 'stages': {}}
    t0 = time.monotonic()
    try:
        if not args.reuse: shutil.rmtree(lab.dir, ignore_errors=True)       # --reuse: the world kept by an earlier deep run, other stages added
        lab.start()
        r = lab.wait_ready()
        try:
            wanted = args.stages.split(',')
            for name, func in (('spawn', lambda: stage_spawn_area(lab, r, trials, row)), ('village', lambda: stage_village(lab, r, trials, row)),
                               ('portal', lambda: stage_ruined_portal(lab, r, trials, row)),
                               ('stronghold', lambda: stronghold_facts(lab, r, trials, row, nearest_usable_stronghold(row))),
                               ('nether', lambda: stage_nether(lab, r, trials, row))):
                if name not in wanted: continue
                t1 = time.monotonic()
                try:
                    result['stages'][name] = func()
                except Exception as error:      # noqa: BLE001
                    result['stages'][name] = {'error': f'{type(error).__name__}: {error}'[:300]}
                result['stages'][name]['secs'] = round(time.monotonic() - t1, 1)
                log(f'deep {key}: {name} {result["stages"][name].get("secs")}s {result["stages"][name].get("error", "")}')
            r.cmd('save-all flush')
        finally:
            r.close()
    finally:
        lab.stop(remove=args.discard)          # --discard: the facts are in the result; the world goes at once (nothing worth keeping is left behind)
    result['totalSecs'] = round(time.monotonic() - t0, 1)
    if not args.discard: result['world'] = os.path.join(lab.dir, 'world')
    return result


def cmd_deep(args):
    trials = load_trials()
    os.makedirs(OUT, exist_ok=True)
    rows = {str(r['seed']): r for r in load_rows([os.path.join(OUT, n) for n in sorted(os.listdir(OUT)) if n.startswith('phaseA-') and n.endswith('.jsonl')])}
    seeds = [s.strip() for s in args.seeds.split(',') if s.strip()]
    for s in seeds:
        if s not in rows or rows[s].get('reject') or not rows[s].get('strongholds'): raise SystemExit(f'seed {s} has no complete phase A line')
    if args.key and len(seeds) > 1: raise SystemExit('--key names one seed (use --keys for several)')
    keys = args.keys.split(',') if args.keys else [None] * len(seeds)
    if len(keys) != len(seeds): raise SystemExit('--keys: one name per seed')
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        # a slot (ports) is held by one world at a time: seed i of the batch uses slot_base + (i % workers)
        futures = []
        free_slots = list(range(args.workers))
        lock = threading.Lock()

        def run(i, s):
            with lock: slot = free_slots.pop(0)
            try: return deep_one(s, rows[s], args.slot_base + slot, args, trials, OUT, keys[i])
            finally:
                with lock: free_slots.append(slot)

        futures = [pool.submit(run, i, s) for i, s in enumerate(seeds)]
        for future in futures:
            res = future.result()
            path = os.path.join(OUT, f'deep-{res["key"]}.json')
            if args.reuse and os.path.exists(path):
                with open(path, encoding='utf-8') as handle: old = json.load(handle)
                old['stages'].update(res['stages'])
                res = {**old, **{k: v for k, v in res.items() if k != 'stages'}, 'stages': old['stages']}      # this run's world and time over the old result's
                if args.discard: res.pop('world', None)
            with open(path, 'w', encoding='utf-8') as handle: json.dump(res, handle, ensure_ascii=False, indent=1)
            log(f'deep {res["key"]}: wrote {path} ({res["totalSecs"]}s)')


# ---------------------------------------------------------------- report: phase A and B together

def final_row(a_row, deep):
    """The phase A line with what phase B measured put in its place (surface lava, the stronghold's real portal room)."""
    row = json.loads(json.dumps(a_row))
    st = deep['stages']
    sp0 = st.get('spawn') or {}
    if sp0.get('surfaceLava') is not None: row['surfaceLava'] = sp0['surfaceLava']
    if 'raw' in sp0:
        row['nearestDiamond'] = (sp0['raw'].get('nearest') or {}).get('diamond_ore', {}).get('distance')       # measured: None means none within 96 m
        row['logs32'] = sp0.get('logs32')
    if sp0.get('hazards'): row['hazards'] = sp0['hazards']
    vi = st.get('village') or {}
    if vi.get('beds') is not None:
        sp_animals = (st.get('spawn') or {}).get('animals') or {}
        livestock = sum((vi.get('animals') or {}).get(k, 0) + sp_animals.get(k, 0) for k in ('cow', 'pig', 'sheep', 'chicken')) + sp_animals.get('rabbit', 0) * 0.5
        row['villageFacts'] = {'beds': vi['beds'], 'cropTotal': vi['cropTotal'], 'livestock': livestock}
    sh = st.get('stronghold') or {}
    if sh.get('portalCenter'):
        for s in row['strongholds']:        # the list stays whole (the nearest is the target); the one that was read gets its room's facts
            if s['at'] == sh['start']:
                s.update({'dRoom': sh['fromSpawn'], 'seaAbove': bool(sh.get('seaAbove')) or bool(s.get('seaAbove')), 'depth': sh.get('depth'), 'portalCenter': sh['portalCenter']})
    return row


def cmd_report(args):
    rows = {str(r['seed']): r for r in load_rows([os.path.join(OUT, n) for n in sorted(os.listdir(OUT)) if n.startswith('phaseA-') and n.endswith('.jsonl')])}
    items = []
    for key in args.keys.split(','):
        with open(os.path.join(OUT, f'deep-{key}.json'), encoding='utf-8') as handle: deep = json.load(handle)
        row = final_row(rows[str(deep['seed'])], deep)
        total, parts = score(row)
        items.append((total, parts, key, row, deep))
    items.sort(key=lambda t: -t[0])
    print('| 順位 | 名前 | シード | 点 | 内訳 |')
    print('|---|---|---|---|---|')
    for i, (total, parts, key, row, deep) in enumerate(items, 1):
        print(f'| {i} | {key} | {row["seed"]} | {total} | {"・".join(f"{k}{p}" for k, p in parts.items())} |')
    for total, parts, key, row, deep in items:
        st = deep['stages']
        sp, vi, po, sh, ne = (st.get(k) or {} for k in ('spawn', 'village', 'portal', 'stronghold', 'nether'))
        v = row.get('village') or {}
        print(f'\n### {key}  シード {row["seed"]}  {total} 点')
        print(f'- スポーン {row["spawn"]} {row.get("spawnBiome")}。地表の溶岩 {sp.get("surfaceLava")}m、原木 {sp.get("nearestLog")}m（32m 内 {sp.get("logs32")} 本）、動物 {sp.get("animals")}、最寄りの羊 {sp.get("nearestSheep")}m、最寄りのダイヤ鉱石 {sp.get("nearestDiamond")}m（水平）')
        hz = sp.get('hazards') or {}
        print(f'  - スポーン直後の危険（半径 64m）：足元の水 {hz.get("waterFrac")}・氷 {hz.get("iceFrac")}、海まで {hz.get("seaNearest")}m、凍ったバイオーム {hz.get("frozenBiomeFrac")}・深い森 {hz.get("denseForestFrac")}、'
              f'起伏（地面の高さの幅）{hz.get("relief")}（{hz.get("groundLow")}〜{hz.get("groundHigh")}）、バイオーム {hz.get("biomes")}')
        print(f'- 村 {short(v.get("id"))} {v.get("d")}m（{v.get("at")}）：ベッド {vi.get("beds")}・畑 {vi.get("cropTotal")}（{vi.get("crops")}）・干し草 {vi.get("hay_block")}・箱 {vi.get("chests")}（{vi.get("chestsByLoot")}）・動物 {vi.get("animals")}')
        rp = row.get('ruinedPortal') or {}
        print(f'- 廃ポータル {short(rp.get("id"))} {rp.get("d")}m：{po.get("blocks")}、最寄りの溶岩 {po.get("nearestLava")}、箱 {po.get("chestLoot")}')
        print(f'- ネザー側 {row.get("netherAt")}：到着地点 {ne.get("arrival")}（スポーン/8 から {ne.get("arrivalOffset")}m）、要塞 {fmt_d(row.get("fortress"))}m・砦 {fmt_d(row.get("bastion"))}m・歪んだ森 {fmt_d(row.get("warped"))}m・クリムゾン {fmt_d(row.get("crimson"))}m')
        fo = ne.get('fortress') or {}
        print(f'  - 要塞 {fo.get("at")}：ブレイズのスポナー {fo.get("blazeSpawners")} 基、{[ (s["at"], s.get("standAt"), s.get("fromArrival")) for s in fo.get("spawners", []) if s["mob"] == "blaze" ]}')
        print(f'  - 歪んだ森の立ち位置 {(ne.get("warped") or {}).get("stand")}')
        s0, bad = nearest_stronghold(row)
        s0 = s0 or {}
        print(f'- 1 輪目のストロングホールド（一番近い＝目玉が指す）：スポーンから {s0.get("dRoom", s0.get("d"))}m、{ {"sea": "海の下", "monument": "海底神殿のそば", None: "陸"}.get(bad, "—") }、'
              f'枠の部屋 {sh.get("portalCenter")}、地下の深さ {sh.get("depth")}、上の地面 {sh.get("surfaceAbove")}、'
              f'目玉が最初から入っている枠 {sh.get("eyesAlreadyIn")}、道の海 {(s0.get("route") or {}).get("sea")}、近くの海底神殿 {s0.get("monument")}m')
        print(f'  - 他の 1 輪目：{[(h["at"], h["d"], h.get("seaAbove"), h.get("monument")) for h in (rows[str(deep["seed"])].get("strongholds") or [])]}')


def cmd_seeds_json(args):
    """seeds.json entries (the shape of the scout's, plus what phase A and B found) for the given deep worlds, printed as JSON."""
    rows = {str(r['seed']): r for r in load_rows([os.path.join(OUT, n) for n in sorted(os.listdir(OUT)) if n.startswith('phaseA-') and n.endswith('.jsonl')])}
    out = []
    for key in args.keys.split(','):
        with open(os.path.join(OUT, f'deep-{key}.json'), encoding='utf-8') as handle: deep = json.load(handle)
        row = final_row(rows[str(deep['seed'])], deep)
        total, parts = score(row)
        st = deep['stages']
        sp, vi, sh, ne = (st.get(k) or {} for k in ('spawn', 'village', 'stronghold', 'nether'))
        v = row.get('village') or {}
        s0, bad = nearest_stronghold(row)
        s0 = s0 or {}
        biome = (row.get('spawnBiome') or '')
        lava = sp.get('surfaceLava')
        d = lambda name: (row.get(name) or {}).get('d')
        hz = sp.get('hazards') or {}
        tags = [biome, f'村 {v.get("d")}m（{short(v.get("id")).replace("village_", "")}、ベッド {vi.get("beds")}・畑 {vi.get("cropTotal")}）',
                f'廃ポータル {d("ruinedPortal")}m', f'地表の溶岩 {str(lava) + "m" if lava is not None else "なし（96m 内）"}',
                f'要塞 {d("fortress")}m・砦 {d("bastion")}m・歪んだ森 {d("warped")}m（ネザー側、スポーン÷8 から）',
                f'ストロングホールド {s0.get("dRoom", s0.get("d"))}m（{ {"sea": "海の下", "monument": "海底神殿のそば", None: "陸"}.get(bad, "—") }、地下 {sh.get("depth")}m）',
                f'足元の水 {hz.get("waterFrac")}・海まで {hz.get("seaNearest")}m・起伏 {hz.get("relief")}']
        out.append({'key': key, 'seed': str(deep['seed']), 'source': f'seedscan 2026-11-02（{total} 点）', 'tags': tags, 'spawn': row['spawn'],
                    'spawnBiome': f'minecraft:{biome}', 'village': v.get('d'), 'ruinedPortal': (row.get('ruinedPortal') or {}).get('d'),
                    'surfaceLava': sp.get('surfaceLava'), 'nearestLog': sp.get('nearestLog'), 'logsWithin32': sp.get('logs32'), 'ironOreWithin48': sp.get('iron48'),
                    'coalOreWithin48': sp.get('coal48'), 'deepLavaChunks': sp.get('deepLavaChunks'), 'animals': sp.get('animals'), 'nearestSheep': sp.get('nearestSheep'),
                    'score': total, 'scoreParts': parts,
                    'nether': {'fortress': d('fortress'), 'bastion': d('bastion'), 'warpedForest': d('warped'),
                               'blazeSpawners': (ne.get('fortress') or {}).get('blazeSpawners')},
                    'stronghold': {'fromSpawn': s0.get('dRoom', s0.get('d')), 'nearestUsable': bad is None, 'portalCenter': sh.get('portalCenter'), 'depth': sh.get('depth'),
                                   'eyesAlreadyIn': sh.get('eyesAlreadyIn'), 'seaOnTheWay': (s0.get('route') or {}).get('sea')},
                    'spawnHazards': hz or None})
    print(json.dumps(out, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- publish: the world and its sites for trials.py and the lab

def build_sites(row, deep):
    """pristine/<key>/sites.json: the positions trials.py S6-S11 start at and look for (KNOWN_SITES in trials.py)."""
    st = deep['stages']
    sites = {'spawn': row['spawn']}
    nether = st.get('nether') or {}
    if nether.get('arrival'): sites['netherArrival'] = nether['arrival']
    blaze = [s for s in (nether.get('fortress') or {}).get('spawners', []) if s['mob'] == 'blaze' and s.get('standAt')]
    if blaze:
        near = min(blaze, key=lambda s: s.get('fromArrival') if s.get('fromArrival') is not None else 10 ** 9)
        sites['blazeSpawner'], sites['blazeStand'] = near['at'], near['standAt']
        sites['blazeSpawners'] = [s['at'] for s in blaze]
    if (nether.get('warped') or {}).get('stand'): sites['warpedStand'] = nether['warped']['stand']
    hold = st.get('stronghold') or {}
    if hold.get('portalCenter'):
        cx, cy, cz = hold['portalCenter']
        sites['strongholdPortalCenter'] = [round(cx), cy, round(cz)]
        sites['strongholdFrames'] = hold['frames']
        if hold.get('stand'): sites['strongholdStand'] = hold['stand']
        if hold.get('surfaceAbove'): sites['strongholdSurface'] = [round(cx), hold['surfaceAbove']['y'] + 1, round(cz)]
    sites['endPlatform'] = [100, 49, 0]
    sites['village'] = [row['village']['at'][0], row['spawn'][1], row['village']['at'][2]]
    return sites


def cmd_publish(args):
    deep_path = os.path.join(OUT, f'deep-{args.key}.json')
    with open(deep_path, encoding='utf-8') as handle: deep = json.load(handle)
    rows = {str(r['seed']): r for r in load_rows([os.path.join(OUT, n) for n in sorted(os.listdir(OUT)) if n.startswith('phaseA-') and n.endswith('.jsonl')])}
    row = rows[str(deep['seed'])]
    dest = os.path.join(args.dest or os.path.join(OUT, 'pristine'), args.key)
    if os.path.exists(dest): shutil.rmtree(dest)
    os.makedirs(dest)
    ignore = shutil.ignore_patterns('session.lock', 'playerdata', 'stats', 'advancements')
    source = args.world_from or deep.get('world')       # --world-from: a staged copy (worlds/<key>) when the working directory of the read is already gone
    if not source or not os.path.isfile(os.path.join(source, 'level.dat')): raise SystemExit(f'no world to publish: {source} (use --world-from <dir with level.dat>)')
    shutil.copytree(source, os.path.join(dest, 'world'), ignore=ignore)
    spawn_stage = deep['stages'].get('spawn') or {}
    raw = spawn_stage.get('raw') or {}
    def loc(hit): return None if not hit else {'distance': hit['d'], 'at': hit['at']}
    facts = {'key': args.key, 'seed': str(deep['seed']), 'serverSeed': row.get('serverSeed'), 'spawn': row['spawn'], 'radius': spawn_stage.get('radius', 96),
             'locate': {'village': loc(row.get('village')), 'ruined_portal': loc(row.get('ruinedPortal')), 'mineshaft': loc(row.get('mineshaft')), 'pillager_outpost': loc(row.get('outpost'))},
             'spawnBiome': row.get('spawnBiome'), 'counts': raw.get('counts', {}), 'animals': raw.get('animals', {}), 'nearest': raw.get('nearest', {}),
             'scoutedAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'note': args.note or 'seedscan phase A+B (2026-11-02)'}
    with open(os.path.join(dest, 'facts.json'), 'w', encoding='utf-8') as handle: json.dump(facts, handle, ensure_ascii=False, indent=1)
    sites = build_sites(row, deep)
    with open(os.path.join(dest, 'sites.json'), 'w', encoding='utf-8') as handle: json.dump(sites, handle, ensure_ascii=False, indent=1)
    log(f'publish {args.key}: {dest}  sites {sorted(sites)}')
    if args.labworld:       # the same ground for the lab probes: MINECRAFT_LAB_WORLD_FROM=<this> MINECRAFT_LAB_TERRAIN=natural
        lab_dest = os.path.join(HOME, '.cache', 'minebot-lab', 'worlds', args.key)
        if os.path.exists(lab_dest): shutil.rmtree(lab_dest)

        def link_or_copy(src, dst):          # one copy on the disk: nothing writes into a staged world (a lab copies it into its own directory)
            try: os.link(src, dst)
            except OSError: shutil.copy2(src, dst)

        shutil.copytree(os.path.join(dest, 'world'), lab_dest, copy_function=link_or_copy)
        shutil.copyfile(os.path.join(dest, 'sites.json'), lab_dest + '.sites.json')       # the places, beside the world (backend/scripts/lab/lab-world.sh prints them)
        log(f'publish {args.key}: lab world {lab_dest} (+ .sites.json)')


# ---------------------------------------------------------------- main

def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('scan')
    p.add_argument('--tag', default=dt.datetime.now().strftime('%Y%m%dT%H%M'))
    p.add_argument('--random', type=int, default=0)
    p.add_argument('--master', type=int, default=20261102)
    p.add_argument('--skip', type=int, default=0)
    p.add_argument('--seeds')
    p.add_argument('--seeds-file')
    p.add_argument('--workers', type=int, default=4)
    p.add_argument('--slot-base', type=int, default=0)
    p.add_argument('--village-max', type=int, default=350)
    p.add_argument('--deep-min', type=int, default=45, help='provisional score from which phase A2 (sea on the way, monuments) runs')
    p.add_argument('--no-gates', action='store_true', help='measure everything for every seed (slow)')
    p.add_argument('--heap', default='1G')
    p.add_argument('--cores', type=int, default=2)
    p = sub.add_parser('rank')
    p.add_argument('files', nargs='*')
    p.add_argument('--top', type=int, default=12)
    p.add_argument('--profile', choices=['film', 'general'], default='film', help='film: the filming run (default); general: the first table')
    p = sub.add_parser('deep')
    p.add_argument('--seeds', required=True, help='seeds that have a complete phase A line in the out directory')
    p.add_argument('--key', help='name of the world (one seed only); default d<digits of the seed>')
    p.add_argument('--keys', help='one name per seed, comma separated (c1,c2,...)')
    p.add_argument('--stages', default=','.join(STAGES))
    p.add_argument('--reuse', action='store_true', help='start from the world an earlier deep run kept and add/replace only --stages in its result')
    p.add_argument('--discard', action='store_true', help='remove the world as soon as it is read (a candidate that is not chosen leaves only its facts)')
    p.add_argument('--workers', type=int, default=1)
    p.add_argument('--slot-base', type=int, default=12)
    p.add_argument('--heap', default='2G')
    p.add_argument('--cores', type=int, default=3)
    p = sub.add_parser('report')
    p.add_argument('--keys', required=True, help='deep-<key>.json files to put in one table, comma separated')
    p = sub.add_parser('seeds-json')
    p.add_argument('--keys', required=True)
    p = sub.add_parser('publish')
    p.add_argument('--key', required=True, help='the deep-<key>.json to publish')
    p.add_argument('--dest', help='default <out>/pristine; the trials directory on the VM is ~/minecraft/shannon-home/trials/pristine')
    p.add_argument('--labworld', action='store_true', help='also stage the ground under ~/.cache/minebot-lab/worlds/<key> for MINECRAFT_LAB_WORLD_FROM')
    p.add_argument('--world-from', help='take the world from this directory (a staged worlds/<key>) instead of the kept working directory of the read')
    p.add_argument('--note')
    args = parser.parse_args(argv)
    if args.cmd == 'scan': cmd_scan(args)
    elif args.cmd == 'rank': cmd_rank(args)
    elif args.cmd == 'deep': cmd_deep(args)
    elif args.cmd == 'report': cmd_report(args)
    elif args.cmd == 'seeds-json': cmd_seeds_json(args)
    elif args.cmd == 'publish': cmd_publish(args)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
