/**
 * A throwaway bench of the head against the real Haiku for the bow and arrows made on the way (the owner's decision of 11/27). Never run by the tests. Same shape as the 1127g bench:
 * `build <records> <out.json> --group=A|B` is run in the tree of each side (A in the tree before the change, B in this one), so each side's own strings (the first plan's system and input,
 * the act's protocol and instructions, the shortage, the flint line, the pack's tidy words) are what the model reads; the recorded decision's other parts are kept as recorded.
 * Scenes: (1) the first plan of a recorded run (11 eyes in the pack); (2) a recorded decision on the road with a bow, 2 arrows, 2 flint, 2 sticks and 1 free slot, with a flock of chickens added
 * to the nearby lines (the record has none that near); (3) the same with no bow and no arrows (B only). `vm-script` makes the runner for the machine that holds the key; `score` reads its results.
 * COUNTED: (plan) a bow node, whether it comes before the stronghold, its doneWhen, how many bow nodes; (act) a hunt of chickens, a plan_update about the bow, a go further than 30 m for the bow's
 * materials, a go back to the village, a night's wait, a shoot hand, a tidy or a drop that throws the bow's materials away. SAMPLES ARE FEW: a count says what happened in them, not a rate.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const GOAL = 'エンドラを討伐して';
type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const ACT_DECISION = 'd0092';
const BOWISH = /弓|矢|羽根|ニワトリ|鶏|クモ|糸|砂利|火打石|bow|arrow|feather|chicken|spider|string|gravel|flint/iu;

// ---------------------------------------------------------------------------------------------------- the run's records (read only)
interface Records { events: Json[]; blob(hash: string): unknown }
function openRecords(dir: string): Records {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
  return { events, blob: hash => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'blobs', `${hash}.json.gz`))).toString('utf8')) };
}
interface RecordedRequest { id: string; config: Json; headers: Record<string, string>; system: unknown; tools: unknown; messages: Array<{ role: string; content: unknown }>; live: Json | null }
function recordedRequest(records: Records, id: string): RecordedRequest {
  const request = records.events.find(event => event.ev === 'request' && event.id === id);
  if (!request) throw new Error(`no request ${id}`);
  const live = records.events.find(event => event.ev === 'live' && record(event.ids)?.decision === id);
  return { id, config: request.config as Json, headers: (request.headers ?? {}) as Record<string, string>, system: records.blob(String(request.system)),
    tools: request.tools ? records.blob(String(request.tools)) : undefined, messages: (request.messages as string[]).map(hash => records.blob(hash) as { role: string; content: unknown }),
    live: live ? JSON.parse(String(live.raw)) as Json : null };
}
function stackOf(text: string): Json {
  const found = /^(.+?)×(\d+)(?:\(耐久(\d+)\/(\d+)\))?$/u.exec(text);
  if (!found) throw new Error(`pack entry unreadable: ${text}`);
  return { name: found[1], count: Number(found[2]), ...(found[3] ? { durability: { left: Number(found[3]), max: Number(found[4]) } } : {}) };
}
const lineOf = (user: string, head: string) => user.split('\n').find(line => line.startsWith(head))?.slice(head.length) ?? '';
function worldOfPlanUser(user: string): Json {
  const pack = lineOf(user, '持ち物: ');
  return { position: JSON.parse(lineOf(user, '位置: ')), dimension: lineOf(user, 'ディメンション: '), biome: lineOf(user, 'バイオーム: '), time: lineOf(user, '時刻: '),
    inventory: pack ? pack.split('・').map(stackOf) : [], worn: lineOf(user, '着ている物: '), health: 20, food: 20 };
}
function worldOfLive(body: Json): Json {
  const state = record(body.state) ?? {};
  const at = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(String(state.at ?? ''));
  return { position: at ? { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) } : undefined, dimension: state.dimension ?? 'overworld', biome: state.biome,
    inventory: (Array.isArray(body.inventory) ? body.inventory : []).map(item => stackOf(String(item))), worn: state.worn, health: state.health, food: state.fullness,
    freeSlots: state.freeSlots };
}
const textOfBlocks = (system: unknown): string[] => (Array.isArray(system) ? system : []).map(block => String(record(block)?.text ?? ''));

// ---------------------------------------------------------------------------------------------------- this tree's strings
const CHICKENS = '食料（動物）: chicken 48m 内に 9体。最寄り (498,87,1598) 西8・北2 11m（#5101） / (501,87,1600) 14m（#5102） / (512,87,1604) 22m（#5103）';
function variantBody(body: Json, variant: 'chicken' | 'nobow'): Json {
  const near = Array.isArray(body.nearby) ? [...body.nearby as string[]] : [];
  const nearby = [near[0], CHICKENS, ...near.slice(1)].filter((line): line is string => typeof line === 'string');
  const inventory = (Array.isArray(body.inventory) ? body.inventory as string[] : []).filter(line => variant === 'chicken' || !/^(?:bow|arrow)×/u.test(line));
  return { ...body, nearby, inventory };
}

async function treeParts(records: Records, variants: ReadonlyArray<'chicken' | 'nobow'>) {
  const { minecraftV2Hooks } = await import('../src/surfaces/minecraft/minecraftLlmcV2.js');
  const { minecraftProfile } = await import('../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js');
  const { ownFirstPlanSystem } = await import('../src/surfaces/minecraft/minecraftStrategy.js');
  const { planFromAnswer, strongholdFirst, eyesForStronghold, firstPlanInput } = await import('../src/surfaces/minecraft/minecraftFirstPlan.js');
  const { readinessParts } = await import('../src/surfaces/minecraft/minecraftLlmcBodyFacts.js');
  const { flintLine } = await import('../src/surfaces/minecraft/minecraftLlmcFacts.js');
  const pack = await import('../src/surfaces/minecraft/minecraftLlmcPack.js') as { packLines: (lines: readonly string[], options?: Json) => string[]; archeryHeld?: (carried: ReadonlyMap<string, number>, now?: string) => Map<string, number> };
  const { carriedItemCounts } = await import('../src/surfaces/minecraft/minecraftItems.js');
  const profile = minecraftProfile({ minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() })!;
  const planRequest = recordedRequest(records, 'p0001');
  const planWorld = worldOfPlanUser(String(planRequest.messages[0]!.content));
  const answerBlocks = records.blob(String(records.events.find(event => event.ev === 'response' && event.id === 'p0001')!.content)) as Json[];
  const answer = JSON.parse(String(answerBlocks.find(block => block.type === 'text')?.text ?? ''));
  const tree = planFromAnswer(strongholdFirst(answer, eyesForStronghold(planWorld as never)), undefined);
  const planUser = firstPlanInput(GOAL, planWorld as never, { readiness: true, journeyReadiness: true, now: Date.parse('2026-11-27T10:00:00Z') });
  const live = recordedRequest(records, ACT_DECISION).live;
  const body0 = record(live?.body);
  if (!body0 || !tree) throw new Error('no live body or no tree');
  const acts: Record<string, { planNow: string | null; shortage: string | null; flint: string | null; pack: string[]; body: Json }> = {};
  for (const variant of variants) {
    const body = variantBody(body0, variant);
    const world = worldOfLive(body);
    const now = String(record(record(body.planFacts)?.now)?.id ?? tree.current ?? '');
    const held = { ...tree, current: tree.nodes.some(node => node.id === now) ? now : tree.current };
    const observation = { schemaVersion: 1, bodyId: 'minecraft:replay', sequence: 1, stateAt: new Date(0).toISOString(), receivedAt: new Date(0).toISOString(), connected: true,
      state: { world }, facts: { alive: true, dimension: world.dimension } } as never;
    const llmc = { journeyReadiness: true, plan: () => undefined, planView: () => null, planTree: () => held } as never;
    const nodeNow = held.nodes.find(node => node.id === held.current);
    const parts = readinessParts(llmc, { path: nodeNow ? [] : [] } as never, observation);
    const kinds = nodeNow ? [nodeNow.kind] : undefined;
    const flint = flintLine(observation, kinds as never);
    const lines = (body.inventory as string[]);
    const carried = carriedItemCounts(world as never, {} as never);
    const keep = pack.archeryHeld ? pack.archeryHeld(carried, nodeNow?.doneWhen) : new Map<string, number>();
    const keepWords = [...keep].map(([item, count]) => `${item}:${count}`).join(',');
    const lined = pack.packLines(lines, { free: 1, ...(keep.size ? { archery: true, held: (item: string) => keep.get(item) ?? 0, keepWords } : {}) });
    acts[variant] = { planNow: parts.planNow ?? null, shortage: parts.shortage ?? null, flint, pack: lined, body };
  }
  return { actProtocol: profile.protocol, actTransient: profile.transient, planSystem: ownFirstPlanSystem(), planUser, acts };
}

// ---------------------------------------------------------------------------------------------------- cases
interface Case { name: string; kind: 'act' | 'plan'; group: string; key: string }
interface Built { notes: string[]; bodies: Record<string, Json>; headers: Record<string, Record<string, string>>; cases: Case[]; shown: Json }

async function build(recordsDir: string, options: { actReps: number; planReps: number; nobowReps: number; group: 'A' | 'B' }): Promise<Built> {
  const records = openRecords(recordsDir);
  const notes: string[] = [], bodies: Record<string, Json> = {}, headers: Record<string, Record<string, string>> = {}, cases: Case[] = [];
  const mine = await treeParts(records, ['chicken', 'nobow']);
  const g = options.group;
  // the first plan
  const planRequest = recordedRequest(records, 'p0001');
  const blocks = planRequest.system as Json[];
  const planSystem = blocks.map((block, index) => index === 1 ? { ...block, text: mine.planSystem } : block);
  bodies[`plan-${g}`] = { ...planRequest.config, system: planSystem, messages: [{ role: 'user', content: mine.planUser }] }; headers[`plan-${g}`] = {};
  for (let n = 1; n <= options.planReps; n += 1) cases.push({ name: `${g}-plan-${n}`, kind: 'plan', group: `${g}:plan`, key: `plan-${g}` });
  // the acts
  const request = recordedRequest(records, ACT_DECISION);
  const texts = textOfBlocks(request.system);
  const system = (request.system as Json[]).map((block, index) => index === 0 ? { ...block, text: mine.actProtocol } : index === 1 ? { ...block, text: mine.actTransient } : block);
  if (texts.length < 2) notes.push('act: the recorded system has fewer than two blocks');
  for (const variant of ['chicken', 'nobow'] as const) {
    if (variant === 'nobow' && g === 'A') continue;
    const part = mine.acts[variant]!;
    const last = request.messages[request.messages.length - 1]!;
    const live = JSON.parse(String(last.content)) as Json;
    const body = record(live.body) ?? {};
    const facts = [...(Array.isArray(body.facts) ? body.facts as string[] : []), ...(part.flint ? [part.flint] : []), ...part.pack];
    const next = { ...live, body: { ...part.body, ...(part.planNow ? { planNow: part.planNow } : {}), ...(part.shortage ? { shortage: part.shortage } : {}), facts } };
    const key = `act-${variant}-${g}`;
    bodies[key] = { ...request.config, system, ...(request.tools ? { tools: request.tools } : {}), messages: [...request.messages.slice(0, -1), { ...last, content: JSON.stringify(next) }] };
    headers[key] = request.headers;
    const reps = variant === 'chicken' ? options.actReps : options.nobowReps;
    for (let n = 1; n <= reps; n += 1) cases.push({ name: `${g}-act-${variant}-${n}`, kind: 'act', group: `${g}:act-${variant}`, key });
  }
  const shown = { planUserHasArchery: mine.planUser.includes('弓矢'), chickenShortage: mine.acts.chicken!.shortage?.slice(0, 1500) ?? null, chickenFlint: mine.acts.chicken!.flint, chickenPack: mine.acts.chicken!.pack,
    nobowFlint: mine.acts.nobow!.flint };
  return { notes, bodies, headers, cases, shown };
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
      const blocks = (json.content || []).map(b => b.type === 'thinking' ? { type: 'thinking', text: String(b.thinking || '').slice(0, 500) } : b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b.input } : { type: b.type });
      console.log('RESULT ' + JSON.stringify({ name: item.name, status: response.status, stop: json.stop_reason, ms: Date.now() - began, usage, costUsd: cost, spent, blocks,
        error: response.ok ? undefined : (json.error && (json.error.type + ': ' + String(json.error.message).slice(0, 300))) }));
    } catch (error) {
      console.log('RESULT ' + JSON.stringify({ name: item.name, failed: String(error && error.name || error), ms: Date.now() - began, spent }));
    } finally { clearTimeout(timer); }
  }
});
`;
function vmScript(builtFiles: string[], outPath: string, cap: number): void {
  const merged: Built = { notes: [], bodies: {}, headers: {}, cases: [], shown: {} };
  for (const file of builtFiles) { const built = JSON.parse(fs.readFileSync(file, 'utf8')) as Built; Object.assign(merged.bodies, built.bodies); Object.assign(merged.headers, built.headers); merged.cases.push(...built.cases); }
  // the order: the cases of both groups turn by turn, so that a stop at the cap leaves a fair comparison
  const byTurn = new Map<string, Case[]>();
  for (const item of merged.cases) { const turn = item.name.replace(/^[AB]-/u, ''); byTurn.set(turn, [...(byTurn.get(turn) ?? []), item]); }
  const runs = [...byTurn.values()].flat().map(item => ({ name: item.name, key: item.key }));
  const payload = Buffer.from(JSON.stringify({ cap, runs, bodies: merged.bodies, headers: merged.headers }), 'utf8').toString('base64');
  fs.writeFileSync(outPath, ['#!/usr/bin/env bash', 'set -u', `PAYLOAD='${payload}'`, "read -r -d '' JS <<'JSEOF'", NODE_RUNNER.trim(), 'JSEOF', 'printf \'%s\' "$PAYLOAD" | base64 -d | node -e "$JS"', ''].join('\n'));
}

// ---------------------------------------------------------------------------------------------------- score
interface Result { name: string; status?: number; costUsd?: number; blocks?: Json[]; skipped?: string; failed?: string; error?: string; stop?: string }
const handsOf = (input: Json): Json[] => (Array.isArray(input.hands) ? input.hands : []).map(record).filter((hand): hand is Json => hand !== null);
const FROM = { x: 506, z: 1596 };
const VILLAGE = { x: 532, z: 1484 };
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
function placesOf(value: unknown, into: Array<{ x: number; z: number }> = []): Array<{ x: number; z: number }> {
  if (Array.isArray(value)) value.forEach(item => placesOf(item, into));
  else { const item = record(value); if (item) { if (typeof item.x === 'number' && typeof item.z === 'number') into.push({ x: item.x, z: item.z }); ['to', 'at', 'goals', 'path'].forEach(key => placesOf(item[key], into)); } }
  return into;
}
export function readAct(blocks: readonly Json[]) {
  const calls = blocks.filter(block => block.type === 'tool_use');
  const acts = calls.filter(call => call.name === 'mc_act').map(call => record(call.input) ?? {});
  const hands = acts.flatMap(handsOf);
  const whys = acts.map(input => String(input.why ?? '')).join(' ');
  const text = JSON.stringify(calls.map(call => call.input));
  const planUpdates = calls.filter(call => call.name === 'plan_update').map(call => JSON.stringify(call.input));
  const far = hands.some(hand => String(hand.do) === 'go' && placesOf(hand).some(place => dist(place, FROM) > 30 && !(place.z >= 1500 && dist(place, { x: 505, z: 1603 }) < 40)) && BOWISH.test(JSON.stringify(hand) + whys));
  const village = hands.some(hand => placesOf(hand).some(place => dist(place, VILLAGE) < 45)) || /村へ戻|村に戻|村へ往復/u.test(whys);
  const night = hands.some(hand => ['sleep', 'wait'].includes(String(hand.do)) && BOWISH.test(whys)) || /夜を待/u.test(whys);
  const tidy = hands.filter(hand => ['tidy', 'drop'].includes(String(hand.do)));
  const throwsMaterial = tidy.some(hand => String(hand.do) === 'drop' ? /flint|feather|string|stick|bow|arrow/u.test(JSON.stringify(hand)) : !/flint/u.test(JSON.stringify(hand)));
  return { first: String(hands[0]?.do ?? ''), huntChicken: hands.some(hand => String(hand.do) === 'hunt' && /chicken/u.test(JSON.stringify(hand))), planUpdateBow: planUpdates.some(item => /弓|矢|bow|arrow/u.test(item)),
    farForBow: far, village, nightWait: night, shootHand: hands.some(hand => String(hand.do) === 'shoot'), tidyHand: tidy.length > 0, tidyThrowsBowMaterial: throwsMaterial, mineGravel: hands.some(hand => String(hand.do) === 'mine' && /gravel/u.test(JSON.stringify(hand))),
    why: whys.slice(0, 110), tools: calls.map(call => String(call.name)), mentionsBow: BOWISH.test(text) };
}
export function readPlanAnswer(text: string) {
  let nodes: Array<{ id: string; parent?: string; title: string; kind?: string; doneWhen?: string }>;
  try { nodes = (JSON.parse(text) as { nodes: typeof nodes }).nodes; } catch { return null; }
  const bow = nodes.filter(node => /弓|矢/u.test(node.title) || /have:(?:bow|arrow)/u.test(node.doneWhen ?? ''));
  const at = (pred: (node: (typeof nodes)[number]) => boolean) => nodes.findIndex(pred);
  const stronghold = at(node => node.kind === 'stronghold'), end = at(node => node.kind === 'end' || /dim:the_end/u.test(node.doneWhen ?? ''));
  const first = bow[0] ? nodes.indexOf(bow[0]) : -1;
  return { nodes: nodes.length, bowNodes: bow.length, bowFirstDoneWhen: bow[0]?.doneWhen ?? null, arrow12: bow.some(node => /arrow>=12/u.test(node.doneWhen ?? '')), arrowOther: bow.map(node => /arrow>=(\d+)/u.exec(node.doneWhen ?? '')?.[1]).filter(Boolean),
    bowBeforeStronghold: first >= 0 && stronghold >= 0 ? first < stronghold : null, bowAfterStronghold: first >= 0 && stronghold >= 0 ? first > stronghold && (end < 0 || first < end) : null, bowTop: bow[0] ? !(bow[0].parent) : null };
}
function count<T>(rows: readonly T[], key: (row: T) => string): Record<string, number> { const out: Record<string, number> = {}; for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1; return out; }
function score(resultsFile: string): unknown {
  const results = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Result);
  const rows = results.map(result => {
    const group = result.name.replace(/-\d+$/u, '');
    if (!result.blocks) return { name: result.name, group, note: result.skipped ?? result.failed ?? result.error ?? 'no answer', costUsd: result.costUsd };
    if (result.name.includes('-plan-')) { const text = String(result.blocks.find(block => block.type === 'text')?.text ?? ''); return { name: result.name, group, ...(readPlanAnswer(text) ?? { note: `unreadable (stop ${result.stop ?? '?'})` }), costUsd: result.costUsd }; }
    return { name: result.name, group, ...readAct(result.blocks), costUsd: result.costUsd };
  });
  const groups = [...new Set(rows.map(row => row.group))].sort();
  const summary = groups.map(group => {
    const mine = rows.filter(row => row.group === group), ok = mine.filter(row => !('note' in row && row.note)) as Array<Record<string, unknown>>;
    const sum: Json = { group, n: ok.length, failed: mine.length - ok.length, costUsd: Number(mine.reduce((total, row) => total + (row.costUsd ?? 0), 0).toFixed(4)) };
    for (const key of ['huntChicken', 'planUpdateBow', 'farForBow', 'village', 'nightWait', 'shootHand', 'tidyHand', 'tidyThrowsBowMaterial', 'mineGravel', 'mentionsBow', 'arrow12', 'bowBeforeStronghold', 'bowAfterStronghold', 'bowTop']) {
      if (ok.some(row => key in row)) sum[key] = ok.filter(row => row[key] === true).length;
    }
    if (ok.some(row => 'bowNodes' in row)) { sum.bowNodes = ok.map(row => row.bowNodes); sum.arrowOther = ok.map(row => row.arrowOther); }
    if (ok.some(row => 'first' in row)) sum.firstHand = count(ok, row => String(row.first));
    return sum;
  });
  return { summary, rows };
}

// ---------------------------------------------------------------------------------------------------- main
async function main(argv: string[]): Promise<void> {
  const [mode, a, b, c] = argv.filter(arg => !arg.startsWith('--'));
  const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (mode === 'build' && a && b) {
    const out = await build(a, { group: (flag('group') ?? 'A') as 'A' | 'B', actReps: Number(flag('act-reps') ?? 5), planReps: Number(flag('plan-reps') ?? 3), nobowReps: Number(flag('nobow-reps') ?? 3) });
    fs.writeFileSync(b, JSON.stringify(out, null, 1));
    console.log(`cases ${out.cases.length}: ${Object.entries(count(out.cases, item => item.group)).map(([name, n]) => `${name}x${n}`).join(' ')}`);
  } else if (mode === 'vm-script' && a && b) {
    vmScript(a.split(','), b, Number(c ?? 0.15));
    console.log('script written');
  } else if (mode === 'score' && a) {
    const out = score(a) as { summary: unknown };
    if (b) fs.writeFileSync(b, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out.summary, null, 1));
  } else {
    console.error('usage: build <records> <out.json> --group=A|B [--act-reps=5 --plan-reps=3 --nobow-reps=3] | vm-script <outA.json,outB.json> <script.sh> [capUsd] | score <results.txt> [out.json]');
    process.exit(2);
  }
}
if (process.argv[1] && /minecraft-bow-bench-1127i/u.test(process.argv[1])) await main(process.argv.slice(2));
