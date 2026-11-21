"""The request queue's side of the section trials (trials.py imports this; README.md says how to use it). Standard library only.

A section with "via": "queue" does not send one goal through the operator CLI. It adds each of its `queue.entries` to the head's request queue, then plays a script of
queue operations (move, hold, resume, start, stop, cancel, delete) against the run, and judges the order things happened in.

The section's `queue` (all of it optional except entries):
  entries   [{ref, goal, placement?}]   added in this order (placement: end | next | now; default end). `ref` is the trial's own name for the row.
  script    [{id?, when, op, ref?, before?}]   run in order, one step at a time. `when` holds when every key holds:
              seconds N                       N seconds after the previous step (the first: after the entries were added)
              milestone NAME                  the section's milestone NAME is latched
              ref R, state S, for N?          row R has been in state S for N seconds (S: queued running paused stopped done failed cancelled absent)
            `op` is the queue's op; `ref` names the row it is about; `before` names the row it goes in front of (null = the end).
  expect    what must have held when the trial ends (each one is a failure of the trial when it did not):
              maxRunning N                    never more than N rows `running` in one reading (default 1 and always checked)
              order [refs]                    these rows became done in this order
              final {ref: state}              the state each row ends in (absent = the row is gone)
              seen {ref: [states]}            these states were read at some time
              halt {step, withinSeconds, stillSeconds}   after that step the body held still (position and item counts) for stillSeconds, starting within withinSeconds
              quiet {step, seconds}           after that step no row was `running` for that many seconds
              scriptDone                      every step ran (default: always checked)

The queue is read from the head's database (read only, like agent_tasks) and written through the door the mod uses: the body's POST /queue (production: 127.0.0.1:8092),
or, in an isolated rig (which has no body door), the head's POST /v1/body/minecraft/queue with the rig body's device token. Tokens are never logged.
"""
import json
import os
import sqlite3
import urllib.error
import urllib.request

TERMINAL = {'done', 'failed', 'cancelled'}
STATES = ('queued', 'running', 'paused', 'stopped', 'done', 'failed', 'cancelled', 'absent')
OPS = ('add', 'delete', 'move', 'start', 'stop', 'cancel', 'hold', 'resume')
NEEDS_REF = {'delete', 'move', 'cancel', 'hold', 'resume'}
WHEN_KEYS = {'seconds', 'milestone', 'ref', 'state', 'for'}
EXPECT_KEYS = {'maxRunning', 'order', 'final', 'seen', 'halt', 'quiet', 'scriptDone'}
PLACEMENTS = ('end', 'next', 'now')
TABLE = 'minecraft_request_queue'
STILL_MOVE = 0.5            # blocks the body may drift and still count as holding still
BODY_URL = os.environ.get('SHANNON_TRIALS_QUEUE_URL', 'http://127.0.0.1:8092/queue')
SENDER = 'trials'


def validate(cfg, milestone_names, where):
    """Problems of one section's `queue` block (empty list = fine)."""
    out = []
    entries = cfg.get('entries') if isinstance(cfg, dict) else None
    if not entries: return [f'{where}: queue has no entries']
    refs = [e.get('ref') for e in entries]
    if len(set(refs)) != len(refs) or not all(isinstance(r, str) and r for r in refs): out.append(f'{where}: queue entry refs must be distinct names')
    goals = [e.get('goal') for e in entries]
    if len(set(goals)) != len(goals) or not all(isinstance(g, str) and 0 < len(g) <= 120 for g in goals): out.append(f'{where}: queue goals must be distinct and 1-120 characters')
    for e in entries:
        if e.get('placement', 'end') not in PLACEMENTS: out.append(f'{where}: placement {e.get("placement")!r} is not one of {PLACEMENTS}')
    steps = cfg.get('script', [])
    ids = [s.get('id') for s in steps if s.get('id')]
    if len(set(ids)) != len(ids): out.append(f'{where}: script step ids twice')
    for n, s in enumerate(steps):
        tag = f'{where}: script step {n + 1}'
        if s.get('op') not in OPS or s.get('op') == 'add': out.append(f'{tag}: op {s.get("op")!r} is not a queue op the script may use')
        if s.get('op') in NEEDS_REF and s.get('ref') not in refs: out.append(f'{tag}: ref {s.get("ref")!r} is not an entry')
        if s.get('ref') is not None and s.get('ref') not in refs: out.append(f'{tag}: ref {s.get("ref")!r} is not an entry')
        if 'before' in s and s['before'] is not None and s['before'] not in refs: out.append(f'{tag}: before {s["before"]!r} is not an entry')
        when = s.get('when')
        if not isinstance(when, dict) or not when: out.append(f'{tag}: no when'); continue
        for k in when:
            if k not in WHEN_KEYS: out.append(f'{tag}: when key {k!r} is unknown')
        if 'ref' in when and (when['ref'] not in refs or when.get('state') not in STATES): out.append(f'{tag}: when needs an entry ref and one of the states')
        if 'state' in when and 'ref' not in when: out.append(f'{tag}: when state needs a ref')
        if 'milestone' in when and when['milestone'] not in milestone_names: out.append(f'{tag}: milestone {when["milestone"]!r} is not in the section')
    expect = cfg.get('expect', {})
    for k in expect:
        if k not in EXPECT_KEYS: out.append(f'{where}: expect key {k!r} is unknown')
    for k in ('halt', 'quiet'):
        if k in expect and expect[k].get('step') not in ids: out.append(f'{where}: expect {k} names a step that has no id')
    for ref in list(expect.get('order', [])) + list(expect.get('final', {})) + list(expect.get('seen', {})):
        if ref not in refs: out.append(f'{where}: expect names {ref!r}, which is not an entry')
    for ref, state in expect.get('final', {}).items():
        if state not in STATES: out.append(f'{where}: final state {state!r} of {ref} is unknown')
    return out


def normalise_row(raw):
    """A row of the head's queue table as the trial reads it. Column names follow the table's contract (snake_case); camelCase is read too."""
    def pick(*names):
        for n in names:
            if raw.get(n) is not None: return raw[n]
        return None
    return {'id': pick('id'), 'seq': pick('seq'), 'goal': pick('goal'), 'state': pick('state'), 'pos': pick('pos'), 'taskId': pick('task_id', 'taskId')}


def read_rows(db_path):
    """All rows of the queue table (read only). A head without the table has no queue: that is an error the trial reports, not an empty queue."""
    con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=10)
    try:
        cur = con.execute(f'SELECT * FROM {TABLE}')
        names = [d[0] for d in cur.description]
        return [normalise_row(dict(zip(names, r))) for r in cur.fetchall()]
    finally:
        con.close()


def post(target, body, timeout=20):
    """One queue operation. target is None (the body's door at BODY_URL) or ('head', url, token). Returns {ok, code, queue} and never raises for an HTTP refusal."""
    if target and target[0] == 'head':
        url, headers, payload = target[1].rstrip('/') + '/v1/body/minecraft/queue', {'authorization': 'Bearer ' + target[2]}, body
    else:
        url, headers, payload = BODY_URL, {}, {**body, 'sender': SENDER}
    req = urllib.request.Request(url, data=json.dumps({k: v for k, v in payload.items() if v is not None or k == 'before'}).encode(),
                                 headers={'content-type': 'application/json', **headers}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp: raw = resp.read()
    except urllib.error.HTTPError as error:
        return {'ok': False, 'code': f'http_{error.code}', 'queue': None}
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        return {'ok': False, 'code': f'unreachable:{type(error).__name__}', 'queue': None}
    try: doc = json.loads(raw)
    except ValueError: return {'ok': False, 'code': 'not_json', 'queue': None}
    ok = doc.get('ok', doc.get('success'))
    return {'ok': bool(ok), 'code': str(doc.get('code') or doc.get('result') or ('ok' if ok else 'refused')), 'queue': doc.get('queue')}


class QueueTrial:
    """The script and the judgement, with no I/O of its own: feed it readings (`observe`), send the operations it returns, ask `verdict` at the end."""

    def __init__(self, cfg, milestone_names=()):
        self.cfg = cfg
        self.entries = cfg['entries']
        self.refs = [e['ref'] for e in self.entries]
        self.goal_ref = {e['goal']: e['ref'] for e in self.entries}
        self.script = cfg.get('script', [])
        self.expect = cfg.get('expect', {})
        self.ids = {}                    # ref -> the row id the head gave it
        self.states = {r: 'absent' for r in self.refs}
        self.since = {r: 0.0 for r in self.refs}
        self.seen = {r: set() for r in self.refs}
        self.completed = []              # refs in the order they were first read as done
        self.violations = []
        self.fired = []                  # {id, index, op, ref, at}
        self.next = 0
        self.last_fire = 0.0
        self.running_at = []             # times of the readings that had a running row
        self.samples = []                # (t, pos, items) of the body
        self.last_t = 0.0
        self.log = []

    # -- readings
    def observe(self, t, rows, body=None, latched=None):
        """One reading of the queue (rows from read_rows) and of the body. Returns the operations due now: [(step index, body of the post)]."""
        mine = {self.goal_ref[r['goal']]: r for r in rows if r.get('goal') in self.goal_ref}
        now = {ref: (mine[ref]['state'] if ref in mine else 'absent') for ref in self.refs}
        for ref, row in mine.items(): self.ids[ref] = row['id']
        for ref in self.refs:
            if now[ref] != self.states[ref]:
                self.log.append({'t': round(t, 1), 'ref': ref, 'from': self.states[ref], 'to': now[ref]})
                self.states[ref], self.since[ref] = now[ref], t
            self.seen[ref].add(now[ref])
            if now[ref] == 'done' and ref not in self.completed: self.completed.append(ref)
        running = [r for r in self.refs if now[r] == 'running']
        if running: self.running_at.append(t)
        limit = self.expect.get('maxRunning', 1)
        if len(running) > limit: self.violations.append(f'running_{len(running)}_at_{t:.0f}s:' + ','.join(running))
        if body: self.samples.append((t, body.get('pos'), body.get('items')))
        self.last_t = t
        due = []
        while self.next < len(self.script) and self._holds(self.script[self.next]['when'], t, latched or {}):
            step = self.script[self.next]
            ref, before = step.get('ref'), step.get('before')
            if any(r not in self.ids for r in (ref, before) if r): break       # a row the head has not shown yet: the step waits
            due.append((self.next, {'op': step['op'], 'id': self.ids.get(ref) if ref else None,
                                    **({'before': self.ids.get(before) if before else None} if 'before' in step else {})}))
            self.fired.append({'id': step.get('id'), 'index': self.next, 'op': step['op'], 'ref': ref, 'at': round(t, 1)})
            self.last_fire = t
            self.next += 1
        return due

    def _holds(self, when, t, latched):
        if 'seconds' in when and t - self.last_fire < when['seconds']: return False
        if 'milestone' in when and when['milestone'] not in latched: return False
        if 'ref' in when:
            if self.states[when['ref']] != when['state']: return False
            if t - self.since[when['ref']] < when.get('for', 0): return False
        return True

    def facts(self):
        """What a queue milestone ({"queue": {"ref", "state"}}) reads: ref -> state now."""
        return dict(self.states)

    # -- the end
    def fired_at(self, step_id):
        for f in self.fired:
            if f['id'] == step_id: return f['at']
        return None

    def _still(self, start, within, hold):
        """True when the body held still for `hold` seconds, starting at most `within` seconds after `start`."""
        run = None
        for t, pos, items in self.samples:
            if t < start: continue
            if t > start + within + hold: break
            if run is None or not _same(run, pos, items):
                run = (t, pos, items); continue
            if t - run[0] >= hold and run[0] <= start + within: return True
        return False

    def verdict(self):
        """The failures of the run (empty list = it did what the script and `expect` say)."""
        fails = list(self.violations)
        if self.next < len(self.script):
            fails.append(f'script_stopped_at_step_{self.next + 1}:{self.script[self.next].get("op")}')
        for ref in self.refs:
            if 'failed' in self.seen[ref] and 'failed' not in (self.expect.get('seen', {}).get(ref) or []): fails.append(f'{ref}_failed')
        e = self.expect
        if 'order' in e:
            got = [r for r in self.completed if r in e['order']]
            if got != list(e['order']): fails.append(f'order:{"".join(got) or "-"}!={"".join(e["order"])}')
        for ref, want in e.get('final', {}).items():
            if self.states[ref] != want: fails.append(f'final_{ref}:{self.states[ref]}!={want}')
        for ref, states in e.get('seen', {}).items():
            for s in states:
                if s not in self.seen[ref]: fails.append(f'never_{s}_{ref}')
        if 'halt' in e:
            at = self.fired_at(e['halt']['step'])
            if at is None: fails.append('halt:step_not_run')
            elif not self._still(at, e['halt'].get('withinSeconds', 10), e['halt'].get('stillSeconds', 4)): fails.append('halt:body_kept_moving')
        if 'quiet' in e:
            at = self.fired_at(e['quiet']['step'])
            if at is None: fails.append('quiet:step_not_run')
            elif self.last_t < at + e['quiet']['seconds']: fails.append('quiet:trial_ended_too_early')
            elif any(at < t <= at + e['quiet']['seconds'] for t in self.running_at): fails.append('quiet:a_row_ran')
        return fails

    def report(self):
        return {'states': dict(self.states), 'completed': list(self.completed), 'fired': list(self.fired), 'changes': self.log[-60:],
                'verdict': self.verdict()}


def _same(run, pos, items):
    _, p0, i0 = run
    if p0 is None or pos is None: return False
    moved = max(abs(a - b) for a, b in zip(p0, pos)) > STILL_MOVE
    gained = items is not None and i0 is not None and items > i0
    return not moved and not gained
