/**
 * A throwaway bench of two of the head's decisions against the real Haiku, from a run's records (read only): the first decision while the first plan was still being written
 * (the default plan's node said to go on with a long walk) and one late decision (the walk to the throwing point after a night; the shortage and the stage words). Never run by the tests.
 * It asks no model itself: `build` makes the requests, `vm-script` wraps them in one LF shell script that a machine holding the key runs (`ssh <host> 'bash -s' < script`; the key is read
 * there from the server's own env file and never printed), `score` reads what came back.
 *
 *   tsx scripts/minecraft-plan-bench-1127e.ts build <records-dir> <out.json> [--reps=8] [--only=A1]
 *   tsx scripts/minecraft-plan-bench-1127e.ts vm-script <out.json> <script.sh> [capUsd=0.15]
 *   ssh azure-constant-server 'bash -s' < script.sh > results.txt
 *   tsx scripts/minecraft-plan-bench-1127e.ts score <results.txt>
 *
 * Groups: A0 (the first decision as recorded) / A1 (its now replaced by the stand-in words of the wait); B0 (the late decision as recorded) / B1 (its now without the stale distances, the
 * shortage with the armour's iron and the obsidian row, the facts with the short obsidian row, the stage words with the End items' waiting numbers).
 * What it counts: A: whether the first hand is a long go (seconds over 30, or a go to a place over 60 m from the feet) or a probe / a short hand. B: whether the first hand moves toward the
 * throwing point (z over 1,200) or goes back (to a village, a bed, an obsidian site) or gathers.
 * SAMPLES ARE FEW: a count says what happened in them, not a rate. The bench replays the head's input only; the body's walking is not measured.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

interface Records { events: Json[]; blob(hash: string): unknown }
function openRecords(dir: string): Records {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
  return { events, blob: hash => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'blobs', `${hash}.json.gz`))).toString('utf8')) };
}
interface Recorded { config: Json; headers: Record<string, string>; system: unknown; tools: unknown; messages: Array<{ role: string; content: unknown }> }
function recorded(records: Records, id: string): Recorded {
  const request = records.events.find(event => event.ev === 'request' && event.id === id);
  if (!request) throw new Error(`no request ${id}`);
  return { config: request.config as Json, headers: (request.headers ?? {}) as Record<string, string>, system: records.blob(String(request.system)),
    tools: request.tools ? records.blob(String(request.tools)) : undefined, messages: (request.messages as string[]).map(hash => records.blob(hash) as { role: string; content: unknown }) };
}
const body = (request: Recorded, messages: Recorded['messages']): Json => ({ ...request.config, system: request.system, ...(request.tools ? { tools: request.tools } : {}), messages });

/** `text` with `from` replaced by `to` once; throws when `from` is not in it exactly once (a rebuild that does not read the run's input is not run). */
function swap(text: string, from: string, to: string, what: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`${what}: the recorded text does not hold the part exactly once`);
  return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
}
function mapContent(message: { role: string; content: unknown }, change: (text: string) => string): { role: string; content: unknown } {
  if (typeof message.content === 'string') return { ...message, content: change(message.content) };
  return { ...message, content: (message.content as Json[]).map(block => typeof block.text === 'string' ? { ...block, text: change(block.text) } : block) };
}

async function build(dir: string, reps: number, flagOnly = ''): Promise<{ notes: string[]; bodies: Record<string, Json>; headers: Record<string, Record<string, string>>; cases: Array<{ name: string; key: string }> }> {
  const records = openRecords(dir);
  const notes: string[] = [];
  const { planNowWhileFirstPlan, armourIronWords } = await import('../src/surfaces/minecraft/minecraftLlmcBodyFacts.js');
  const { noPickObsidianLine, } = await import('../src/surfaces/minecraft/minecraftLlmcFightFacts.js');
  const { whereWithoutDistance } = await import('../src/surfaces/minecraft/minecraftLlmcNode.js');
  const { V2_STAGES } = await import('../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js');
  const bodies: Record<string, Json> = {}, headers: Record<string, Record<string, string>> = {};

  // A: the first decision
  const a = recorded(records, 'd0001');
  const lastA = a.messages[a.messages.length - 1]!;
  const textOf = (message: { content: unknown }) => typeof message.content === 'string' ? message.content : (message.content as Json[]).map(block => String(block.text ?? '')).join('');
  bodies.A0 = body(a, a.messages); headers.A0 = a.headers;
  const liveA = JSON.parse(textOf(lastA)) as Json;
  const bodyA = record(liveA.body)!;
  const nowA = String(bodyA.planNow);
  const title = /^(\[p[\d.]+\] [^（]*（最低12・安心24）)/u.exec(nowA)?.[1] ?? nowA.slice(0, 40);
  const nextA = { ...liveA, body: { ...bodyA, planNow: planNowWhileFirstPlan(title, null, null, null) } };
  bodies.A1 = body(a, [...a.messages.slice(0, -1), { ...lastA, content: JSON.stringify(nextA) }]); headers.A1 = a.headers;
  notes.push(`A1 planNow: ${planNowWhileFirstPlan(title, null, null, null)}`);

  // B: the late decision
  const b = recorded(records, 'd0200');
  const lastB = b.messages[b.messages.length - 1]!;
  bodies.B0 = body(b, b.messages); headers.B0 = b.headers;
  const liveB = JSON.parse(textOf(lastB)) as Json;
  const bodyB = record(liveB.body)!;
  let planNow = String(bodyB.planNow), shortage = String(bodyB.shortage);
  const titleOld = '（残り 1,344m・海を含む）', whereOld = '。途中 (398,-24,545) 地下、残り約 771m';
  const whereNew = `。${whereWithoutDistance('途中 (398,-24,545) 地下、残り約 771m')}`;
  planNow = swap(swap(planNow, titleOld, '', 'planNow title'), whereOld, whereNew, 'planNow where');
  const pack = new Map<string, number>((bodyB.inventory as string[]).map(item => { const m = /^(.+?)×(\d+)/u.exec(item)!; return [m[1]!, Number(m[2])] as [string, number]; }));
  shortage = swap(shortage, '防具 3/4（足が無い）', `防具 3/4（足が無い）${armourIronWords(['足'], pack)}`, 'shortage armour');
  shortage = swap(shortage, '・黒曜石 7/8（あと 1）・矢 6/12', '・黒曜石 7/8（あと 1）。掘る手段が無い（ダイヤのつるはしが荷に無い）・矢 6/12', 'shortage obsidian row');
  const noPick = noPickObsidianLine(pack, 'overworld', true)!;
  shortage = `${shortage}。${noPick}`;
  const facts = [...(bodyB.facts as string[]), noPickObsidianLine(pack, 'overworld', false, true)!];
  const nextB = { ...liveB, body: { ...bodyB, planNow, shortage, facts } };
  // the stage words (message 1): the End items' waiting numbers and the pearl's next hands
  const GATHER_OLD = '（集めるのはそこまで。ある分のベッドも使う）。';
  const GATHER_NEW = `${GATHER_OLD}集めるのは道中・要塞の後ろで取れる分だけ: 集めるために地上へ戻る往復・ベッド 1 個のための往復はしない。待つ 10 分も遅さなので、待つ分数と集める往復の分数を並べて選ぶ（待つのを前提にしない）。`;
  const PEARL_OLD = '（この実走の記録にエンダーマンは 0 体だった）。';
  const PEARL_NEW = `${PEARL_OLD}\n- 投げが割れて 10 個になった時の次の手（数）: 枠の所で、パールが 1 個あれば足して 11 個（72%）・2 個あれば 12 個（100%）。パールが 0 個なら、エンダーマン待ちは最初に止めてから 10 分を上限にし、出なければ 10 個（34%）のまま枠へ進む。開かない時は枠の目玉を拾う・パールを探す。11 個ある時は、パールを探さずその 11 個（72%）で進んでよい。理由: 夜の平原で待つ分と、ネザーへの往復（10 分以上）は、72% を 100% にするのに見合わないことが多い。`;
  for (const [what, was, now] of [['gather', GATHER_OLD, GATHER_NEW], ['pearl', PEARL_OLD, PEARL_NEW]] as const) {
    if (!JSON.stringify(V2_STAGES).includes(JSON.stringify(now).slice(1, -1))) notes.push(`stage words ${what}: not found in the tree's own stage words (check)`);
  }
  const messagesB = b.messages.map((message, index) => {
    if (index === b.messages.length - 1) return { ...message, content: JSON.stringify(nextB) };
    if (index !== 1) return message;
    try { return mapContent(mapContent(message, text => swap(text, GATHER_OLD, GATHER_NEW, 'stage gather')), text => swap(text, PEARL_OLD, PEARL_NEW, 'stage pearl')); }
    catch (error) { notes.push(`stage words left as recorded (${String(error)})`); return message; }
  });
  bodies.B1 = body(b, messagesB); headers.B1 = b.headers;
  notes.push(`B1 planNow: ${planNow.slice(0, 260)}`);

  const cases: Array<{ name: string; key: string }> = [];
  for (let n = 1; n <= reps; n += 1) for (const key of (flagOnly ? [flagOnly] : ['A0', 'A1', 'B0', 'B1'])) cases.push({ name: `${key}-${n}`, key });
  return { notes, bodies, headers, cases };
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
      const blocks = (json.content || []).map(b => b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b.input } : { type: b.type });
      console.log('RESULT ' + JSON.stringify({ name: item.name, status: response.status, stop: json.stop_reason, ms: Date.now() - began, costUsd: cost, spent, blocks,
        error: response.ok ? undefined : (json.error && (json.error.type + ': ' + String(json.error.message).slice(0, 300))) }));
    } catch (error) {
      console.log('RESULT ' + JSON.stringify({ name: item.name, failed: String(error && error.name || error), ms: Date.now() - began, spent }));
    } finally { clearTimeout(timer); }
  }
});
`;

function vmScript(outJson: string, cap: number): string {
  const built = JSON.parse(fs.readFileSync(outJson, 'utf8')) as { bodies: Json; headers: Json; cases: Array<{ name: string; key: string }> };
  const payload = Buffer.from(JSON.stringify({ cap, runs: built.cases, bodies: built.bodies, headers: built.headers }), 'utf8').toString('base64');
  return ['#!/usr/bin/env bash', 'set -u', `PAYLOAD='${payload}'`, "read -r -d '' JS <<'JSEOF'", NODE_RUNNER.trim(), 'JSEOF', 'printf \'%s\' "$PAYLOAD" | base64 -d | node -e "$JS"', ''].join('\n');
}

const placesOf = (value: unknown, into: Array<{ x: number; z: number }> = []): Array<{ x: number; z: number }> => {
  if (Array.isArray(value)) value.forEach(item => placesOf(item, into));
  else { const item = record(value); if (item) { if (typeof item.x === 'number' && typeof item.z === 'number') into.push({ x: item.x, z: item.z }); ['to', 'at', 'goals', 'path'].forEach(key => placesOf(item[key], into)); } }
  return into;
};
/** The first call's reading: its tool and first hand, whether it is a long go (a go over 30 s or to a place over 60 m from the feet at (223,-20) for A, (444,1137) for B), and where it heads. */
function read(group: string, blocks: Json[]): Json {
  const call = blocks.find(block => block.type === 'tool_use');
  if (!call) return { tool: null, klass: 'none' };
  const input = record(call.input) ?? {};
  if (call.name !== 'mc_act') return { tool: call.name, klass: call.name === 'mc_probe' || call.name === 'mc_view' ? 'probe' : 'other' };
  const hands = (Array.isArray(input.hands) ? input.hands : []).map(record).filter((hand): hand is Json => hand !== null);
  const feet = group.startsWith('A') ? { x: 223, z: -20 } : { x: 444, z: 1137 };
  const far = (hand: Json) => placesOf(hand).some(place => Math.hypot(place.x - feet.x, place.z - feet.z) > 60);
  const longGo = hands.some(hand => hand.do === 'go' && (Number(hand.seconds ?? 0) > 30 || far(hand)));
  const goes = hands.filter(hand => hand.do === 'go').flatMap(hand => placesOf(hand));
  const south = goes.some(place => place.z >= 1200);
  const first = hands[0] ? String(hands[0].do) : '';
  const why = String(input.why ?? '').slice(0, 110);
  const klass = group.startsWith('A') ? (longGo ? 'long_go' : first === 'wait' || first === 'sleep' ? 'wait' : 'short_or_other') : south ? 'toward_throw_point' : longGo ? 'long_go_elsewhere' : 'other';
  return { tool: call.name, first, klass, longGo, south, why };
}
function score(resultsFile: string): unknown {
  const rows = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Json);
  const out: Record<string, Json> = {};
  for (const row of rows) {
    const group = String(row.name).replace(/-\d+$/u, '');
    const entry = out[group] ?? (out[group] = { n: 0, failed: 0, cost: 0, klass: {}, whys: [] });
    if (!row.blocks) { entry.failed = Number(entry.failed) + 1; continue; }
    const got = read(group, row.blocks as Json[]);
    entry.n = Number(entry.n) + 1; entry.cost = Number((Number(entry.cost) + Number(row.costUsd ?? 0)).toFixed(4));
    const klass = entry.klass as Record<string, number>; klass[String(got.klass)] = (klass[String(got.klass)] ?? 0) + 1;
    (entry.whys as string[]).push(`${got.tool}/${got.first}: ${got.why ?? ''}`);
  }
  return out;
}

const [mode, a, b, c] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const flag = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (mode === 'build' && a && b) {
  const out = await build(a, Number(flag('reps') ?? 8), flag('only') ?? '');
  fs.writeFileSync(b, JSON.stringify(out, null, 1));
  out.notes.forEach(note => console.log(`NOTE ${note}`));
  console.log(`cases ${out.cases.length}`);
} else if (mode === 'vm-script' && a && b) {
  fs.writeFileSync(b, vmScript(a, Number(c ?? 0.15)));
  console.log('script written');
} else if (mode === 'score' && a) {
  console.log(JSON.stringify(score(a), null, 1));
} else {
  console.error('usage: build <records-dir> <out.json> [--reps=8] | vm-script <out.json> <script.sh> [capUsd] | score <results.txt>');
  process.exit(2);
}
