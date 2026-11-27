/**
 * A throwaway bench of the head's act decision against the real Haiku, for the line of height and speed and the line of recent gos (a run's two scenes, both a decision that sent a go to a surface goal from below: 735 m from the goal at y -26,
 * and 150 m from it at y -7 with a spider in view). Never run by the tests. It asks no model itself:
 * `build` makes the requests (group A: the recorded request as it was; group B: the same request with this tree's lines put into its live state), `vm-script` wraps them in one LF
 * shell script that a machine holding the Haiku key runs (`ssh <host> 'bash -s' < script`; the key is read there from the server's own env file and never printed), `score` reads
 * what came back. A run's records are read only.
 *
 *   tsx scripts/minecraft-height-bench-1127e.ts build <records> <out.json> [--reps=8] [--scenes=d0109,d0158]
 *   tsx scripts/minecraft-height-bench-1127e.ts vm-script <out.json> <script.sh> [capUsd=0.15]
 *   ssh azure-constant-server 'bash -s' < script.sh > results.txt
 *   tsx scripts/minecraft-height-bench-1127e.ts score <results.txt> <out.json>
 *
 * WHAT B CHANGES in the recorded live state: the plan's queue lines lose 「直近の go は …」 when the last go sent before the decision had a goal 15 m or more away (the rule of this
 * tree), gain the line of height (`queueLines` of this tree, from the frame's feet and the goals the run had sent), and the old full-pack words are put right where they stand.
 * A recorded string is never edited by hand. WHAT IS COUNTED: the first tool call; whether a hand is a vertical going up; a go whose goal is at the surface (y >= 45) or 100 m or more away;
 * a go to a place under the ground; a drop or sleep before a go; a short go (goal under 15 m); and whether `maxDig` of an underground go was raised against the last one sent.
 * SAMPLES ARE FEW: a count says what happened in them, not a rate. The bench replays the head's input only: what a vertical does once sent, and the way down from the surface, are not measured.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
interface Records { events: Json[]; blob(hash: string): unknown }
export function openRecords(dir: string): Records {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
  return { events, blob: hash => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'blobs', `${hash}.json.gz`))).toString('utf8')) };
}
interface Pos { x: number; y: number; z: number }
const pos = (value: unknown): Pos | null => { const at = record(value); return at && typeof at.x === 'number' && typeof at.y === 'number' && typeof at.z === 'number' ? { x: at.x, y: at.y, z: at.z } : null; };
const level = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.z - b.z);

function goalsOf(hand: Json): Pos[] {
  const out: Pos[] = [];
  for (const key of ['to', 'goals', 'path']) {
    const value = hand[key];
    if (Array.isArray(value)) value.forEach(item => { const at = pos(item); if (at) out.push(at); });
    else { const at = pos(value); if (at) out.push(at); }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- read
/** A hand as the model wrote it: a JSON object in a string, or the short form 「sleep seconds=45」. */
function parseHand(value: unknown): Json | null {
  if (typeof value !== 'string') return record(value);
  const text = value.trim().replace(/^json\s+/u, '');
  if (text.startsWith('{')) { try { return record(JSON.parse(text)); } catch { return null; } }
  const [kind, ...rest] = text.split(/\s+/u);
  const hand: Json = { do: kind };
  for (const part of rest) { if (part === 'up' || part === 'down') { hand.dir = part; continue; }
    const xyz = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u.exec(part);
    if (xyz) { hand.goals = [{ x: Number(xyz[1]), y: Number(xyz[2]), z: Number(xyz[3]) }]; continue; }
    const eq = part.indexOf('='); if (eq > 0) { const raw = part.slice(eq + 1); hand[part.slice(0, eq)] = Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : raw; } }
  return hand;
}
export interface HeightRead { tool: string | null; readsVertical: boolean; first: string; vertical: boolean; verticalUp: boolean; goSurface: boolean; goFar: boolean; goUnder: boolean; short: boolean; dropBeforeGo: boolean; sleepOnly: boolean;
  maxDigUp: boolean; hands: string[]; why: string }
/** What the answer's first call does, counted as the bench's questions ask. `feet` is where the scene stands; `lastGo` the last go sent before the scene (its maxDig). */
export function classifyHeight(blocks: unknown, feet: Pos, lastGo: { maxDig?: number } | null): HeightRead {
  const calls = (Array.isArray(blocks) ? blocks : []).map(record).filter((block): block is Json => block?.type === 'tool_use');
  const call = calls[0];
  const empty = { readsVertical: false, vertical: false, verticalUp: false, goSurface: false, goFar: false, goUnder: false, short: false, dropBeforeGo: false, sleepOnly: false, maxDigUp: false, hands: [], why: '' };
  if (!call) return { tool: null, first: '', ...empty };
  const input = record(call.input) ?? {};
  if (call.name !== 'mc_act') return { tool: String(call.name), first: '', ...empty, readsVertical: call.name === 'skill_read' && /vertical/u.test(String(input.name ?? '')) };
  const hands = (Array.isArray(input.hands) ? input.hands : []).map(parseHand).filter((hand): hand is Json => hand !== null);
  const read: HeightRead = { tool: 'mc_act', first: String(hands[0]?.do ?? ''), ...empty, hands: hands.map(hand => String(hand.do)), why: String(input.why ?? '').slice(0, 110) };
  hands.forEach((hand, index) => {
    if (hand.do === 'vertical') { read.vertical = true; if (hand.dir === 'up' || (typeof hand.toY === 'number' && hand.toY > feet.y)) read.verticalUp = true; }
    if (hand.do === 'go') {
      const goals = goalsOf(hand), near = goals.length ? Math.min(...goals.map(goal => level(goal, feet))) : null;
      if (goals.some(goal => goal.y >= 45)) read.goSurface = true;
      if (near !== null && near >= 100) read.goFar = true;
      if (goals.length && goals.every(goal => goal.y < 45)) read.goUnder = true;
      if (near !== null && near < 15) read.short = true;
      if (typeof hand.maxDig === 'number' && lastGo?.maxDig !== undefined && hand.maxDig > lastGo.maxDig) read.maxDigUp = true;
      if (hands.slice(0, index).some(before => before.do === 'drop')) read.dropBeforeGo = true;
    }
  });
  read.sleepOnly = hands.length > 0 && hands.every(hand => hand.do === 'sleep' || hand.do === 'wait');
  return read;
}

// ---------------------------------------------------------------------------------------------------- build
interface Case { name: string; scene: string; group: 'A' | 'B'; key: string; feet: Pos; lastGoMaxDig?: number }
interface Built { notes: string[]; bodies: Record<string, Json>; headers: Record<string, Record<string, string>>; cases: Case[] }
const SCENES = ['d0109', 'd0158'];

async function treeLines(feet: Pos, sent: Json[], open: Json[]): Promise<{ height: string | null; hopsKept: boolean; surface: Pos | null; last: Pos | null }> {
  const { queueLines } = await import('../src/surfaces/minecraft/minecraftLlmcQueueWords.js');
  let last: Pos | null = null, surface: Pos | null = null;
  for (const event of sent) for (const hand of (Array.isArray(record(event.arguments)?.hands) ? record(event.arguments)!.hands as Json[] : [])) {
    if (hand.do !== 'go') continue;
    const goal = goalsOf(hand)[0];
    if (goal) { last = goal; if (goal.y >= 45) surface = goal; }
  }
  const frame = { state: { world: { dimension: 'overworld', position: feet } } } as never;
  const lines = queueLines([], frame, { progress: null, leftMs: 0 }, { wakeMs: 6000, leftMs: 0, altitude: { lastGoal: last, surfaceGoal: surface, lastDropM: null, samples: [], tune: {} } });
  void open;
  return { height: lines.find(line => line.startsWith('高さ')) ?? null, hopsKept: false, surface, last };
}

async function build(dir: string, reps: number, scenes: readonly string[]): Promise<Built> {
  const records = openRecords(dir);
  const { FULL_COST } = await import('../src/surfaces/minecraft/minecraftLlmcPack.js');
  const { digRoomWords } = await import('../src/surfaces/minecraft/minecraftLlmcPack.js');
  const notes: string[] = [], bodies: Record<string, Json> = {}, headers: Record<string, Record<string, string>> = {}, cases: Case[] = [];
  const OLD_FULL = 'これ以上拾えない（黒曜石・鉱石・落とし物も。dig・pickup・make の物も入らず止まる）';
  const OLD_ROOM = '掘り進む手（go の dig・mine・dig）の前に空きを 10 以上にする（掘る岩の種類ごとに 1 マス埋まる: 丸石・深層岩・土・安山岩など。理由: 満杯だと掘った物が入らず止まる）。';
  for (const id of scenes) {
    const request = records.events.find(event => event.ev === 'request' && event.id === id);
    if (!request) throw new Error(`no request ${id}`);
    const live = records.events.find(event => event.ev === 'live' && record(event.ids)?.decision === id)!;
    const raw = JSON.parse(String(live.raw)) as Json;
    const state = record(record(raw.body)?.state);
    const at = String(state?.at ?? ''), match = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(at);
    if (!match) throw new Error(`${id}: no feet`);
    const feet = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
    const config = request.config as Json, hdr = (request.headers ?? {}) as Record<string, string>;
    const system = records.blob(String(request.system)), tools = request.tools ? records.blob(String(request.tools)) : undefined;
    const messages = (request.messages as string[]).map(hash => records.blob(hash) as { role: string; content: unknown });
    const bodyOf = (msgs: typeof messages): Json => ({ ...config, system, ...(tools ? { tools } : {}), messages: msgs });
    // the gos sent before this decision (for the last go's goal and maxDig, and for the rule of the hops line)
    const sent = (records.events as Json[]).filter(event => event.ev === 'sent' && String(event.at) < String(request.at));
    const goHands = sent.flatMap(event => (Array.isArray(record(event.arguments)?.hands) ? record(event.arguments)!.hands as Json[] : []).filter(hand => hand.do === 'go'));
    const lastGoHand = goHands.at(-1) ?? null, lastGoal = lastGoHand ? goalsOf(lastGoHand)[0] ?? null : null;
    const lastGoal15 = !!lastGoal && level(lastGoal, feet) >= 15;
    const keyA = `${id}-A`, keyB = `${id}-B`;
    bodies[keyA] = bodyOf(messages); headers[keyA] = hdr;
    // group B: the live message of the request
    const last = messages[messages.length - 1]!;
    const text = typeof last.content === 'string' ? last.content : '';
    let liveNow: Json | null = null;
    try { liveNow = JSON.parse(text) as Json; } catch { /* not a live message */ }
    if (!liveNow || JSON.stringify(liveNow) !== text) {
      notes.push(`${id}: the last message does not round-trip through JSON: group B is left as recorded`);
      bodies[keyB] = bodies[keyA]!; headers[keyB] = hdr;
    } else {
      let json = text;
      const was = (json.match(new RegExp(OLD_FULL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) ?? []).length;
      json = json.split(OLD_FULL).join(FULL_COST);
      const roomWas = json.includes(OLD_ROOM);
      json = json.split(OLD_ROOM).join(digRoomWords(3).split('drop は水が近い所')[0]! );
      const next = JSON.parse(json) as Json;
      // the queue's lines sit in an array of the live state (the recorded shape differs by scene): found by what is in it
      const isQueueLines = (value: unknown): value is string[] => Array.isArray(value) && value.some(item => typeof item === 'string' && (item.startsWith('列に項目なし') || item.startsWith('列の残り')));
      const holders: string[][] = [];
      const walk = (value: unknown): void => {
        if (isQueueLines(value)) holders.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else { const item = record(value); if (item) Object.values(item).forEach(walk); }
      };
      walk(next);
      let removedHops = false, addedHeight = false;
      const holder = holders[0];
      if (holder) {
        const made = await treeLines(feet, sent, []);
        for (let index = holder.length - 1; index >= 0; index -= 1) if (lastGoal15 && holder[index]!.startsWith('直近の go は ')) { holder.splice(index, 1); removedHops = true; }
        if (made.height) {
          const at2 = holder.findIndex(line => line.startsWith('列の残り')), at3 = holder.findIndex(line => line.startsWith('列に項目なし'));
          holder.splice(at2 >= 0 ? at2 + 1 : at3 >= 0 ? at3 + 1 : holder.length, 0, made.height);
          addedHeight = true;
        }
      }
      notes.push(`${id}: full words replaced ${was}, room words ${roomWas}, hops line removed ${removedHops} (last go goal 15 m or more away: ${lastGoal15}), height line added ${addedHeight}`);
      bodies[keyB] = bodyOf([...messages.slice(0, -1), { ...last, content: JSON.stringify(next) }]); headers[keyB] = hdr;
    }
    for (let n = 1; n <= reps; n += 1) for (const group of ['A', 'B'] as const) {
      cases.push({ name: `${id}-${group}-${n}`, scene: id, group, key: group === 'A' ? keyA : keyB, feet, ...(typeof lastGoHand?.maxDig === 'number' ? { lastGoMaxDig: lastGoHand.maxDig } : {}) });
    }
  }
  // turn by turn, A then B, scene by scene, so that a stop at the cap leaves a fair comparison
  const ordered = Array.from({ length: reps }, (_, index) => cases.filter(item => item.name.endsWith(`-${index + 1}`))).flat();
  return { notes, bodies, headers, cases: ordered };
}

// ---------------------------------------------------------------------------------------------------- the runner on the machine that holds the key
const NODE_RUNNER = String.raw`
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const env = fs.readFileSync('/home/azureuser/.config/shannon-ios/api.env', 'utf8');
  const pick = name => { const m = new RegExp('^(?:export\\s+)?' + name + '=(.*)$', 'm').exec(env); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const key = pick('SHANNON_HAIKU_API_KEY') || pick('SHANNON_ANTHROPIC_API_KEY');
  if (!key) { console.log('NOKEY'); return; }
  let spent = 0;
  for (const item of input.runs) {
    if (spent >= input.cap) { console.log('RESULT ' + JSON.stringify({ name: item.name, skipped: 'cap', spent })); continue; }
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 170000);
    const began = Date.now();
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: abort.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(input.headers[item.key] || {}) }, body: JSON.stringify(input.bodies[item.key]) });
      const json = await response.json();
      const usage = json.usage || {};
      const cost = ((usage.input_tokens || 0) * 0.1 + (usage.output_tokens || 0) * 0.5 + (usage.cache_creation_input_tokens || 0) * 0.125 + (usage.cache_read_input_tokens || 0) * 0.01) / 1e6;
      spent += cost;
      const blocks = (json.content || []).map(b => b.type === 'thinking' ? { type: 'thinking', text: String(b.thinking || '').slice(0, 900) } : b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b.input } : { type: b.type });
      console.log('RESULT ' + JSON.stringify({ name: item.name, model: json.model, status: response.status, stop: json.stop_reason, ms: Date.now() - began, usage, costUsd: cost, spent, blocks,
        error: response.ok ? undefined : (json.error && (json.error.type + ': ' + String(json.error.message).slice(0, 300))) }));
    } catch (error) {
      console.log('RESULT ' + JSON.stringify({ name: item.name, failed: String(error && error.name || error), ms: Date.now() - began, spent }));
    } finally { clearTimeout(timer); }
  }
});
`;
function vmScript(outJson: string, cap: number): string {
  const built = JSON.parse(fs.readFileSync(outJson, 'utf8')) as Built;
  const runs = built.cases.map(item => ({ name: item.name, key: item.key }));
  const payload = Buffer.from(JSON.stringify({ cap, runs, bodies: built.bodies, headers: built.headers }), 'utf8').toString('base64');
  return ['#!/usr/bin/env bash', 'set -u', `PAYLOAD='${payload}'`, "read -r -d '' JS <<'JSEOF'", NODE_RUNNER.trim(), 'JSEOF', 'printf \'%s\' "$PAYLOAD" | base64 -d | node -e "$JS"', ''].join('\n');
}

// ---------------------------------------------------------------------------------------------------- score
interface Result { name: string; model?: string; status?: number; costUsd?: number; blocks?: Json[]; skipped?: string; failed?: string; error?: string; ms?: number }
function score(resultsFile: string, casesFile: string): unknown {
  const cases = new Map((JSON.parse(fs.readFileSync(casesFile, 'utf8')) as Built).cases.map(item => [item.name, item]));
  const results = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Result);
  const rows = results.map(result => {
    const item = cases.get(result.name)!;
    if (!result.blocks) return { name: result.name, scene: item.scene, group: item.group, note: result.skipped ?? result.failed ?? result.error ?? 'no answer' };
    return { name: result.name, scene: item.scene, group: item.group, model: result.model, costUsd: result.costUsd, ...classifyHeight(result.blocks, item.feet, item.lastGoMaxDig !== undefined ? { maxDig: item.lastGoMaxDig } : null) };
  });
  const groups = [...new Set(rows.map(row => `${row.scene}-${row.group}`))];
  const summary = groups.map(group => {
    const mine = rows.filter(row => `${row.scene}-${row.group}` === group && !('note' in row)) as Array<HeightRead & { costUsd?: number }>;
    const count = (pick: (row: HeightRead) => boolean) => mine.filter(pick).length;
    return { group, n: mine.length, failed: rows.filter(row => `${row.scene}-${row.group}` === group && 'note' in row).length,
      verticalUp: count(row => row.verticalUp), readsVerticalFirst: count(row => row.readsVertical), goSurfaceOrFar: count(row => row.goSurface || row.goFar), goUnderOnly: count(row => row.goUnder && !row.goSurface && !row.goFar),
      maxDigRaised: count(row => row.maxDigUp), dropBeforeGo: count(row => row.dropBeforeGo), sleepOnly: count(row => row.sleepOnly), shortGo: count(row => row.short),
      costUsd: Number(mine.reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(4)) };
  });
  return { summary, rows };
}

async function main(argv: string[]): Promise<void> {
  const [mode, a, b, c] = argv.filter(arg => !arg.startsWith('--'));
  const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (mode === 'build' && a && b) {
    const out = await build(a, Number(flag('reps') ?? 8), flag('scenes')?.split(',') ?? SCENES);
    fs.writeFileSync(b, JSON.stringify(out, null, 1));
    out.notes.forEach(note => console.log(`NOTE ${note}`));
    console.log(`cases ${out.cases.length}`);
  } else if (mode === 'vm-script' && a && b) {
    fs.writeFileSync(b, vmScript(a, Number(c ?? 0.15)));
    console.log('script written');
  } else if (mode === 'score' && a && b) {
    const out = score(a, b);
    const outFile = flag('out');
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
    console.log(JSON.stringify((out as { summary: unknown }).summary, null, 1));
  } else {
    console.error('usage: build <records> <out.json> [--reps=8 --scenes=d0109,d0158] | vm-script <out.json> <script.sh> [capUsd] | score <results.txt> <built.json> [--out=score.json]');
    process.exit(2);
  }
}
if (process.argv[1] && /minecraft-height-bench-1127e/u.test(process.argv[1])) await main(process.argv.slice(2));
