/**
 * A throwaway bench of the head against the real Haiku, for the frames the body remembers (a run's d0049: the live state said "枠 155m 南 (505,31,1603) ×12" in the body's own record and, in the
 * ledger's line, that a third throw is allowed, and the model threw a fourth eye). Never run by the tests. It asks no model itself:
 * `parts` (run once in each tree) writes what that tree makes of the resumed world for the first plan, `build` makes the requests, `vm-script` wraps them in one LF shell script that a machine
 * holding the Haiku key runs (`ssh <host> 'bash -s' < script`; the key is read there from the server's own env file and never printed), `score` reads what came back.
 *
 *   tsx scripts/minecraft-frame-bench-1127f.ts parts <records> <out.json>                       (in the base tree, then in this tree)
 *   tsx scripts/minecraft-frame-bench-1127f.ts build <records> <base-parts.json> <out.json> [--reps=6]
 *   tsx scripts/minecraft-frame-bench-1127f.ts vm-script <out.json> <script.sh> [capUsd=0.15]
 *   ssh azure-constant-server 'bash -s' < script.sh > results.txt
 *   tsx scripts/minecraft-frame-bench-1127f.ts score <results.txt> <out.json>
 *
 * GROUPS. act (d0049's request, the last live message): A as recorded; B with the ledger's crossing line put by this tree's line for frames the body remembers (`frameFoundWords`) and the
 * Nether comparison line left out, as `eyeLinesOf` does. plan (the first plan of a resumed task: the pack of the first plan's record with 10 eyes, standing at the room's door, the body's
 * record holding the frames and the three throws the ledger had): A the recorded system with the input the base tree makes; B this tree's system and input. A recorded string is never edited by hand.
 * COUNTED. act: the first tool call; any hand that throws an eye into the sky (`use ender_eye` with no `at`); a `mc_probe kind=frames`; a go toward the frames (within 80 m of them).
 * plan: a node that throws eyes or draws the crossing again (its title says 投げ / 交点を絞), a node that walks to the frames, and the stronghold node's place. SAMPLES ARE FEW.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const GOAL = 'エンドラを討伐して';
const FRAMES = { x: 505, y: 31, z: 1603 };
const ROW = '10m 南 (505,31,1603) ×12';
const THROWS = [
  { dim: 'overworld', x: 197, z: -245, yawDeg: 171.2, flewM: 12, broke: true, atMs: 1_000 },
  { dim: 'overworld', x: 176, z: -241, yawDeg: 170.5, flewM: 12, broke: true, atMs: 2_000 },
  { dim: 'overworld', x: 438, z: 1312, yawDeg: 171.2, flewM: 12, broke: false, atMs: 3_000 },
];

interface Records { events: Json[]; blob(hash: string): unknown }
export function openRecords(dir: string): Records {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
  return { events, blob: hash => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'blobs', `${hash}.json.gz`))).toString('utf8')) };
}
interface Recorded { config: Json; headers: Record<string, string>; system: unknown; tools: unknown; messages: Array<{ role: string; content: unknown }> }
function recordedRequest(records: Records, id: string): Recorded {
  const request = records.events.find(event => event.ev === 'request' && event.id === id);
  if (!request) throw new Error(`no request ${id}`);
  return { config: request.config as Json, headers: (request.headers ?? {}) as Record<string, string>, system: records.blob(String(request.system)),
    tools: request.tools ? records.blob(String(request.tools)) : undefined, messages: (request.messages as string[]).map(hash => records.blob(hash) as { role: string; content: unknown }) };
}

function stackOf(text: string): Json {
  const found = /^(.+?)×(\d+)(?:\(耐久(\d+)\/(\d+)\))?$/u.exec(text);
  if (!found) throw new Error(`pack entry unreadable: ${text}`);
  return { name: found[1], count: Number(found[2]), ...(found[3] ? { durability: { left: Number(found[3]), max: Number(found[4]) } } : {}) };
}
const lineOf = (user: string, head: string) => user.split('\n').find(line => line.startsWith(head))?.slice(head.length) ?? '';
/** The resumed task's world: the first plan record's pack with 10 eyes, at the room's door, with the body's own record of the frames and the throws. */
function resumedWorld(planUser: string): Json {
  const pack = lineOf(planUser, '持ち物: ');
  const inventory = (pack ? pack.split('・').map(stackOf) : []).filter(item => item.name !== 'ender_eye').concat([{ name: 'ender_eye', count: 10 }]);
  return { position: { x: 508, y: 84, z: 1597 }, dimension: 'overworld', biome: 'plains', time: '12500', health: 20, food: 20, inventory, worn: lineOf(planUser, '着ている物: '),
    rememberedPlaces: { nether_portal: '1729m 北 (196,-34,-244) ×6', end_portal_frame: ROW }, eyeThrows: THROWS };
}

// ---------------------------------------------------------------------------------------------------- parts (per tree)
async function parts(dir: string): Promise<Json> {
  const records = openRecords(dir);
  const planUser = String(recordedRequest(records, 'p0001').messages[0]!.content);
  const { ownFirstPlanSystem } = await import('../src/surfaces/minecraft/minecraftStrategy.js');
  const { firstPlanInput, openingDraft, seedPlan } = await import('../src/surfaces/minecraft/minecraftFirstPlan.js');
  const user = firstPlanInput(GOAL, resumedWorld(planUser), { readiness: true, journeyReadiness: true, draft: openingDraft(seedPlan(GOAL, 'overworld')), now: Date.parse('2026-11-27T01:50:00Z') });
  return { system: ownFirstPlanSystem(), user };
}

// ---------------------------------------------------------------------------------------------------- classify
export interface ActRead { tool: string | null; throwsEye: boolean; probesFrames: boolean; goesToFrames: boolean; hands: string[]; why: string }
export function classifyAct(blocks: unknown): ActRead {
  const calls = (Array.isArray(blocks) ? blocks : []).map(record).filter((block): block is Json => block?.type === 'tool_use');
  const call = calls[0];
  const empty = { throwsEye: false, probesFrames: false, goesToFrames: false, hands: [] as string[], why: '' };
  if (!call) return { tool: null, ...empty };
  const input = record(call.input) ?? {};
  if (call.name === 'mc_probe') return { tool: 'mc_probe', ...empty, probesFrames: input.kind === 'frames' };
  if (call.name !== 'mc_act') return { tool: String(call.name), ...empty };
  const hands = (Array.isArray(input.hands) ? input.hands : []).map(raw => {
    if (typeof raw !== 'string') return record(raw);
    const text = raw.trim().replace(/^json\s+/u, '');
    if (text.startsWith('{')) { try { return record(JSON.parse(text)); } catch { return null; } }
    const [kind, ...rest] = text.split(/\s+/u);
    const hand: Json = { do: kind };
    for (const part of rest) {
      const xyz = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u.exec(part);
      if (xyz) { hand.goals = [{ x: Number(xyz[1]), y: Number(xyz[2]), z: Number(xyz[3]) }]; continue; }
      const eq = part.indexOf('=');
      if (eq > 0) hand[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return hand;
  }).filter((hand): hand is Json => hand !== null);
  const places = (hand: Json): Array<{ x: number; z: number }> => ['to', 'goals', 'at'].flatMap(key => {
    const value = hand[key];
    return (Array.isArray(value) ? value : [value]).map(record).filter((item): item is Json => !!item && typeof item.x === 'number' && typeof item.z === 'number').map(item => ({ x: item.x as number, z: item.z as number }));
  });
  return { tool: 'mc_act', throwsEye: hands.some(hand => hand.do === 'use' && String(hand.item ?? '').replace(/^minecraft:/u, '') === 'ender_eye' && !hand.at),
    probesFrames: false, goesToFrames: hands.some(hand => hand.do === 'go' && places(hand).some(place => Math.hypot(place.x - FRAMES.x, place.z - FRAMES.z) <= 80)),
    hands: hands.map(hand => String(hand.do)), why: String(input.why ?? '').slice(0, 120) };
}
export interface PlanRead { nodes: number; throwNode: boolean; walkToFrames: boolean; strongholdAt: number | null; titles: string[] }
export function classifyPlan(blocks: unknown): PlanRead {
  const text = String((Array.isArray(blocks) ? blocks : []).map(record).find(block => block?.type === 'text')?.text ?? '');
  let answer: Json | null = null;
  try { answer = record(JSON.parse(text)); } catch { const found = /\{[\s\S]*\}/u.exec(text); if (found) { try { answer = record(JSON.parse(found[0])); } catch { answer = null; } } }
  const nodes: Json[] = [];
  const walk = (list: unknown): void => { for (const item of Array.isArray(list) ? list : []) { const node = record(item); if (node) { nodes.push(node); walk(node.children); walk(node.nodes); } } };
  walk(answer?.nodes ?? answer?.plan ?? answer?.tree);
  const titles = nodes.map(node => String(node.title ?? ''));
  const all = nodes.map(node => `${node.title ?? ''} ${node.doneWhen ?? ''}`);
  const stronghold = nodes.findIndex(node => String(node.kind ?? '') === 'stronghold' || /要塞|ストロングホールド/u.test(String(node.title ?? '')));
  return { nodes: nodes.length, throwNode: all.some(item => /投げ|交点を絞/u.test(item)), walkToFrames: all.some(item => /枠(へ|に|まで|の所|の近く)|枠.{0,6}(歩|向か|行)/u.test(item)),
    strongholdAt: stronghold < 0 ? null : stronghold + 1, titles: titles.slice(0, 12) };
}

// ---------------------------------------------------------------------------------------------------- build
interface Case { name: string; kind: 'act' | 'plan'; group: 'A' | 'B'; key: string }
interface Built { notes: string[]; bodies: Record<string, Json>; headers: Record<string, Record<string, string>>; cases: Case[] }
function spliceFrom(recorded: string, oldPart: string, newPart: string): string | null {
  if (!oldPart) return null;
  const at = recorded.indexOf(oldPart);
  if (at < 0 || recorded.indexOf(oldPart, at + 1) >= 0) return null;
  return `${recorded.slice(0, at)}${newPart}${recorded.slice(at + oldPart.length)}`;
}

async function build(dir: string, baseFile: string, reps: number): Promise<Built> {
  const records = openRecords(dir), base = JSON.parse(fs.readFileSync(baseFile, 'utf8')) as { system: string; user: string };
  const mine = await parts(dir);
  const { frameFoundWords } = await import('../src/surfaces/minecraft/minecraftEyeLedger.js');
  const { rememberedFramesOf } = await import('../src/surfaces/minecraft/minecraftSeenMarks.js');
  const notes: string[] = [], bodies: Record<string, Json> = {}, headers: Record<string, Record<string, string>> = {}, cases: Case[] = [];
  // act: d0049
  const act = recordedRequest(records, 'd0049');
  const bodyOf = (messages: Recorded['messages']): Json => ({ ...act.config, system: act.system, ...(act.tools ? { tools: act.tools } : {}), messages });
  bodies['act-A'] = bodyOf(act.messages); headers['act-A'] = act.headers;
  const last = act.messages[act.messages.length - 1]!;
  const live = JSON.parse(String(last.content)) as Json;
  const facts = record(live.body)?.facts as string[] | undefined;
  const at = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(String(record(record(live.body)?.state)?.at ?? ''));
  const known = rememberedFramesOf({ rememberedPlaces: { end_portal_frame: '155m 南 (505,31,1603) ×12' } });
  const crossing = facts?.findIndex(line => line.startsWith('交点 (')) ?? -1;
  if (!facts || !at || !known || crossing < 0) { notes.push('act: the live state has no crossing line or feet: group B is left as recorded'); bodies['act-B'] = bodies['act-A']!; }
  else {
    const eyes = 11;
    const next = [...facts];
    next[crossing] = frameFoundWords(known, { x: Number(at[1]), z: Number(at[3]) }, eyes);
    const compare = next.findIndex(line => line.startsWith('ネザー経由で比べる材料'));
    if (compare >= 0) next.splice(compare, 1);
    (record(live.body) as Json).facts = next;
    bodies['act-B'] = bodyOf([...act.messages.slice(0, -1), { ...last, content: JSON.stringify(live) }]);
    notes.push(`act: crossing line replaced (index ${crossing}), the Nether comparison line removed: ${compare >= 0}`);
  }
  headers['act-B'] = act.headers;
  // plan: the first plan of a resumed task
  const plan = recordedRequest(records, 'p0001');
  const planBody = (system: unknown, user: string): Json => ({ ...plan.config, system, messages: [{ role: 'user', content: user }] });
  bodies['plan-A'] = planBody(plan.system, base.user); headers['plan-A'] = {};
  const blocks = plan.system as Json[];
  const swapped = blocks.map(block => spliceFrom(String(block.text ?? ''), base.system, String(mine.system)));
  const where = swapped.findIndex(text => text !== null);
  if (where < 0) notes.push('plan: the recorded system does not hold the base tree\'s text: B keeps the recorded system');
  bodies['plan-B'] = planBody(where < 0 ? plan.system : blocks.map((block, index) => index === where ? { ...block, text: swapped[where] } : block), String(mine.user)); headers['plan-B'] = {};
  notes.push(`plan: system spliced ${where >= 0}; user A ${base.user.length} chars, B ${String(mine.user).length} chars`);
  for (let n = 1; n <= reps; n += 1) for (const kind of ['act', 'plan'] as const) for (const group of ['A', 'B'] as const) cases.push({ name: `${kind}-${group}-${n}`, kind, group, key: `${kind}-${group}` });
  return { notes, bodies, headers, cases };
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
      const blocks = (json.content || []).map(b => b.type === 'thinking' ? { type: 'thinking', text: String(b.thinking || '').slice(0, 600) } : b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b.input } : { type: b.type });
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
interface Result { name: string; blocks?: Json[]; costUsd?: number; skipped?: string; failed?: string; error?: string }
function score(resultsFile: string, casesFile: string): unknown {
  const cases = new Map((JSON.parse(fs.readFileSync(casesFile, 'utf8')) as Built).cases.map(item => [item.name, item]));
  const results = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Result);
  const rows = results.map(result => {
    const item = cases.get(result.name)!;
    if (!result.blocks) return { name: result.name, kind: item.kind, group: item.group, note: result.skipped ?? result.failed ?? result.error ?? 'no answer' };
    return { name: result.name, kind: item.kind, group: item.group, costUsd: result.costUsd, ...(item.kind === 'act' ? classifyAct(result.blocks) : classifyPlan(result.blocks)) };
  });
  const summary = (['act', 'plan'] as const).flatMap(kind => (['A', 'B'] as const).map(group => {
    const mine = rows.filter(row => row.kind === kind && row.group === group && !('note' in row)) as Array<Json>;
    const count = (pick: (row: Json) => boolean) => mine.filter(pick).length;
    return { kind, group, n: mine.length, failed: rows.filter(row => row.kind === kind && row.group === group && 'note' in row).length,
      ...(kind === 'act' ? { throwsEye: count(row => row.throwsEye === true), probesFrames: count(row => row.probesFrames === true), goesToFrames: count(row => row.goesToFrames === true),
        wait: count(row => (row.hands as string[]).length > 0 && (row.hands as string[]).every(item => item === 'sleep' || item === 'wait')) }
        : { throwNode: count(row => row.throwNode === true), walkToFrames: count(row => row.walkToFrames === true) }),
      costUsd: Number(mine.reduce((sum, row) => sum + Number(row.costUsd ?? 0), 0).toFixed(4)) };
  }));
  return { summary, rows };
}

async function main(argv: string[]): Promise<void> {
  const [mode, a, b, c] = argv.filter(arg => !arg.startsWith('--'));
  const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (mode === 'parts' && a && b) { fs.writeFileSync(b, JSON.stringify(await parts(a), null, 1)); console.log('parts written'); }
  else if (mode === 'build' && a && b && c) {
    const out = await build(a, b, Number(flag('reps') ?? 6));
    fs.writeFileSync(c, JSON.stringify(out, null, 1));
    out.notes.forEach(note => console.log(`NOTE ${note}`));
    console.log(`cases ${out.cases.length}`);
  } else if (mode === 'vm-script' && a && b) { fs.writeFileSync(b, vmScript(a, Number(c ?? 0.15))); console.log('script written'); }
  else if (mode === 'score' && a && b) {
    const out = score(a, b);
    const outFile = flag('out');
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
    console.log(JSON.stringify((out as { summary: unknown }).summary, null, 1));
  } else { console.error('usage: parts <records> <out> | build <records> <base-parts> <out> [--reps=6] | vm-script <out> <script.sh> [cap] | score <results> <built> [--out=f]'); process.exit(2); }
}
if (process.argv[1] && /minecraft-frame-bench-1127f/u.test(process.argv[1])) await main(process.argv.slice(2));
