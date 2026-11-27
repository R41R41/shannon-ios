/**
 * A throwaway bench of the head against the real Haiku for the pearl night (the floor of the pearl hunt is the eyes to hold, and a night spent for the pearls is hunted only when armed).
 * Never run by the tests. It takes one recorded decision of a run (eyes 11, the stronghold's crossing ahead, three throws on the ledger, no frame in view) and changes only what the
 * scene needs: the clock, the health, the shield, what is near, the bow and the string, and the plan's now (`planNow`), which this tree (or the tree before the change) makes of the same world.
 * Usage (run once in each tree, then build and score in the new one):
 *   scenes <records dir> <out.json>            the plan's now of the four scenes, as this tree makes it
 *   build <records dir> <before.json> <after.json> <out.json> [--reps=3]
 *   vm-script <out.json> <script.sh> [capUsd]  the runner for the machine that holds the key
 *   score <results.txt>
 * Scenes: A no frame, eyes 11, day (tick 3000); B the same at night with health 20, an iron sword and a shield, an enderman near; C the same night with no enderman and a spider near,
 * no bow; D the night with no shield and health 10. COUNTED: a sleep booked (a `sleep` hand without `on=false`), `sleep on=false`, a `wait`, only waiting hands, a hand that names an enderman.
 * SAMPLES ARE FEW: a count says what happened in them, not a rate.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const DECISION = 'd0042';
const THROWS = [
  { dim: 'overworld', x: 197, z: -245, yawDeg: 171.2, flewM: 12, broke: true, atMs: Date.parse('2026-11-27T01:20:10Z') },
  { dim: 'overworld', x: 176, z: -241, yawDeg: 170.5, flewM: 12, broke: true, atMs: Date.parse('2026-11-27T01:22:30Z') },
  { dim: 'overworld', x: 438, z: 1312, yawDeg: 171.2, flewM: 12, broke: false, atMs: Date.parse('2026-11-27T01:43:00Z') },
];
const SCENES = ['A', 'B', 'C', 'D'] as const;
type Scene = typeof SCENES[number];
const CLOCK: Record<Scene, { tick: number; text: string }> = {
  A: { tick: 3000, text: '昼（夜まで 約 8 分）' }, B: { tick: 15000, text: '夜（朝まで 約 7 分）' }, C: { tick: 15000, text: '夜（朝まで 約 7 分）' }, D: { tick: 15000, text: '夜（朝まで 約 7 分）' } };
const HEALTH: Record<Scene, number> = { A: 20, B: 20, C: 20, D: 10 };
const SHIELD: Record<Scene, boolean> = { A: true, B: true, C: true, D: false };
const BOW: Record<Scene, boolean> = { A: false, B: false, C: false, D: false };

interface Records { events: Json[]; blob(hash: string): unknown }
function openRecords(dir: string): Records {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
  return { events, blob: hash => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'blobs', `${hash}.json.gz`))).toString('utf8')) };
}
function recorded(records: Records) {
  const request = records.events.find(event => event.ev === 'request' && event.id === DECISION)!;
  const live = records.events.find(event => event.ev === 'live' && record(event.ids)?.decision === DECISION)!;
  return { config: request.config as Json, headers: (request.headers ?? {}) as Record<string, string>, system: records.blob(String(request.system)),
    tools: request.tools ? records.blob(String(request.tools)) : undefined, messages: (request.messages as string[]).map(hash => records.blob(hash) as { role: string; content: unknown }),
    live: JSON.parse(String(live.raw)) as Json };
}
const stack = (text: string) => { const found = /^(.+?)×(\d+)/u.exec(text); return { name: found![1]!, count: Number(found![2]) }; };
const inventoryOf = (scene: Scene, body: Json): string[] => (body.inventory as string[]).filter(item => !(item.startsWith('bow×') && !BOW[scene]) && !(item.startsWith('shield×') && !SHIELD[scene]));
const wornOf = (scene: Scene, worn: string): string => SHIELD[scene] ? worn : worn.replace(/、左手: shield\([^)]*\)/u, '');
function nearOf(scene: Scene): { near: string[]; threats: string[] } {
  if (scene === 'B') return { near: ['#5001 enderman 18m (452,69,1318)', '#4133 chicken 49.3m (486,69,1314)'], threats: ['#4521 skeleton 31.8m (418,68,1309)'] };
  if (scene === 'C') return { near: ['#4133 chicken 49.3m (486,69,1314)'], threats: ['#5002 spider 12m (446,69,1330)', '#4521 skeleton 31.8m (418,68,1309)'] };
  if (scene === 'D') return { near: ['#4133 chicken 49.3m (486,69,1314)'], threats: ['#5003 zombie 14m (430,69,1320)', '#4521 skeleton 31.8m (418,68,1309)'] };
  return { near: ['#4133 chicken 49.3m (486,69,1314)'], threats: ['#4521 skeleton 31.8m (418,68,1309)'] };
}

/** The plan's now of each scene, as this tree makes it from the scene's world. */
interface SceneText { planNow: string | null; endgame: string[] }
async function scenes(recordsDir: string): Promise<Record<string, SceneText>> {
  const { planFromSeeds } = await import('@shannon/mind');
  const { readinessParts } = await import('../src/surfaces/minecraft/minecraftLlmcBodyFacts.js');
  const { nightArmsLine, nightBedLine } = await import('../src/surfaces/minecraft/minecraftNightArms.js');
  const { pearlNowOf } = await import('../src/surfaces/minecraft/minecraftNightPearl.js');
  const { carriedItemCounts } = await import('../src/surfaces/minecraft/minecraftItems.js');
  const body = record(recorded(openRecords(recordsDir)).live.body)!;
  const tree = planFromSeeds([{ id: 'p2', title: '目を投げ直して交点を絞る', kind: 'stronghold' } as never]);
  const out: Record<string, SceneText> = {};
  for (const scene of SCENES) {
    const state = record(body.state)!;
    const world = { dimension: 'overworld', timeOfDay: CLOCK[scene].tick, health: HEALTH[scene], food: 20, worn: wornOf(scene, String(state.worn)), position: { x: 440, y: 84, z: 1325 },
      mapLandmarks: [], eyeThrows: THROWS, nearbyEntities: nearOf(scene).near.map(line => entityOf(line)), nearbyThreats: nearOf(scene).threats.map(line => entityOf(line)),
      inventory: inventoryOf(scene, body).map(stack) };
    const observation = { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '2026-11-27T01:43:54Z', receivedAt: 't', connected: true, state: { world, bodyRun: { bodyBoot: 'bb', connectionId: 'c' } }, facts: {} } as never;
    const counts = carriedItemCounts(world as never, {} as never);
    const pearlNow = pearlNowOf({ kindPearl: false, world, counts, dimension: 'overworld', endStage: true, journey: true });
    const endgame = [nightArmsLine(world, counts, 'overworld'), nightBedLine(world, counts, 'overworld', pearlNow)].filter((line): line is string => !!line);
    const planNow = readinessParts({ plan: () => undefined, planView: () => null, planTree: () => tree, journeyReadiness: true } as never, null, observation, 'bench-1127i').planNow ?? null;
    out[scene] = { planNow, endgame };
  }
  return out;
}
function entityOf(line: string): Json {
  const found = /^#(\d+) (\w+) ([\d.]+)m \((-?\d+),(-?\d+),(-?\d+)\)/u.exec(line)!;
  return { id: Number(found[1]), name: found[2], distance: Number(found[3]), position: { x: Number(found[4]), y: Number(found[5]), z: Number(found[6]) } };
}

interface Built { bodies: Record<string, Json>; headers: Record<string, Record<string, string>>; cases: Array<{ name: string; key: string }> }
function build(recordsDir: string, before: Record<string, SceneText>, after: Record<string, SceneText>, reps: number): Built {
  const base = recorded(openRecords(recordsDir));
  const bodies: Record<string, Json> = {}, headers: Record<string, Record<string, string>> = {}, cases: Built['cases'] = [];
  const last = base.messages[base.messages.length - 1]!;
  for (const scene of SCENES) for (const group of ['old', 'new'] as const) {
    const live = JSON.parse(JSON.stringify(base.live)) as Json;
    const body = record(live.body)!, state = record(body.state)!;
    const text = (group === 'old' ? before : after)[scene]!;
    body.planNow = text.planNow ?? '';
    if (text.endgame.length) body.endgame = { lines: text.endgame };
    state.time = CLOCK[scene].text; state.health = HEALTH[scene]; state.worn = wornOf(scene, String(state.worn));
    body.inventory = inventoryOf(scene, body);
    const near = nearOf(scene); body.near = near.near; body.threats = near.threats;
    const key = `${group}-${scene}`;
    bodies[key] = { ...base.config, system: base.system, ...(base.tools ? { tools: base.tools } : {}), messages: [...base.messages.slice(0, -1), { ...last, content: JSON.stringify(live) }] };
    headers[key] = base.headers;
  }
  for (let n = 1; n <= reps; n += 1) for (const scene of SCENES) for (const group of ['old', 'new'] as const) cases.push({ name: `${group}-${scene}-${n}`, key: `${group}-${scene}` });
  return { bodies, headers, cases };
}

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
      const blocks = (json.content || []).map(b => b.type === 'thinking' ? { type: 'thinking', text: String(b.thinking || '').slice(0, 700) } : b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b.input } : { type: b.type });
      console.log('RESULT ' + JSON.stringify({ name: item.name, status: response.status, stop: json.stop_reason, ms: Date.now() - began, costUsd: cost, spent, blocks, error: response.ok ? undefined : (json.error && (json.error.type + ': ' + String(json.error.message).slice(0, 300))) }));
    } catch (error) {
      console.log('RESULT ' + JSON.stringify({ name: item.name, failed: String(error && error.name || error), ms: Date.now() - began, spent }));
    } finally { clearTimeout(timer); }
  }
});
`;
function vmScript(outJson: string, cap: number): string {
  const built = JSON.parse(fs.readFileSync(outJson, 'utf8')) as Built;
  const payload = Buffer.from(JSON.stringify({ cap, runs: built.cases, bodies: built.bodies, headers: built.headers }), 'utf8').toString('base64');
  return ['#!/usr/bin/env bash', 'set -u', `PAYLOAD='${payload}'`, "read -r -d '' JS <<'JSEOF'", NODE_RUNNER.trim(), 'JSEOF', 'printf \'%s\' "$PAYLOAD" | base64 -d | node -e "$JS"', ''].join('\n');
}

interface Result { name: string; blocks?: Json[]; costUsd?: number; skipped?: string; failed?: string; error?: string }
function score(file: string): unknown {
  const results = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Result);
  const rows = results.map(result => {
    const group = result.name.replace(/-\d+$/u, '');
    if (!result.blocks) return { name: result.name, group, note: result.skipped ?? result.failed ?? result.error ?? 'no answer' };
    const call = result.blocks.find(block => block.type === 'tool_use');
    const input = record(call?.input) ?? {};
    const hands = (Array.isArray(input.hands) ? input.hands : []).map(record).filter((hand): hand is Json => hand !== null);
    const text = JSON.stringify(input);
    const dos = hands.map(hand => String(hand.do));
    return { name: result.name, group, tool: call ? String(call.name) : null, dos,
      sleepBooked: hands.some(hand => hand.do === 'sleep' && hand.on !== false), sleepOff: hands.some(hand => hand.do === 'sleep' && hand.on === false),
      wait: dos.includes('wait'), onlyWaiting: hands.length > 0 && dos.every(item => item === 'wait' || item === 'sleep'), enderman: /enderman|エンダーマン/u.test(text), costUsd: result.costUsd,
      why: String(input.why ?? '').slice(0, 130) };
  });
  const groups = [...new Set(rows.map(row => row.group))];
  const summary = groups.map(group => {
    const mine = rows.filter(row => row.group === group && !('note' in row)) as Array<Record<string, unknown>>;
    const n = (key: string) => mine.filter(row => row[key] === true).length;
    return { group, n: mine.length, sleepBooked: n('sleepBooked'), sleepOff: n('sleepOff'), wait: n('wait'), onlyWaiting: n('onlyWaiting'), enderman: n('enderman'), costUsd: Number(mine.reduce((sum, row) => sum + Number(row.costUsd ?? 0), 0).toFixed(4)) };
  });
  return { summary, rows };
}

async function main(argv: string[]): Promise<void> {
  const [mode, a, b, c, d] = argv.filter(arg => !arg.startsWith('--'));
  const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (mode === 'scenes' && a && b) { fs.writeFileSync(b, JSON.stringify(await scenes(a), null, 1)); console.log('scenes written'); }
  else if (mode === 'build' && a && b && c && d) {
    const out = build(a, JSON.parse(fs.readFileSync(b, 'utf8')) as Record<string, SceneText>, JSON.parse(fs.readFileSync(c, 'utf8')) as Record<string, SceneText>, Number(flag('reps') ?? 3));
    fs.writeFileSync(d, JSON.stringify(out)); console.log(`cases ${out.cases.length}`);
  } else if (mode === 'vm-script' && a && b) { fs.writeFileSync(b, vmScript(a, Number(c ?? 0.1))); console.log('script written'); }
  else if (mode === 'score' && a) console.log(JSON.stringify(score(a), null, 1));
  else { console.error('usage: scenes <records> <out.json> | build <records> <before.json> <after.json> <out.json> [--reps=3] | vm-script <out.json> <script.sh> [capUsd] | score <results.txt>'); process.exit(2); }
}
if (process.argv[1] && /minecraft-pearl-bench-1127i/u.test(process.argv[1])) await main(process.argv.slice(2));
