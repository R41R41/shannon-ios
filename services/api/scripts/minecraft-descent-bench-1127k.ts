/**
 * A throwaway bench of the head's act decision against the real Haiku, for the words of a stay on a high top (a run's four scenes, all decisions that waited on a top 36 to 40 m over the ground). Never run by the tests.
 * It asks no model itself: `build` makes the requests (OLD: the recorded request as it was; ABE: the same request with this tree's height line, wait streak, aloft-first bow-less line and replan words put into its last
 * live state; ALL: ABE plus the wait line, the diamond words and the End knowledge rewritten in every message that holds it), `vm-script` wraps them in one LF shell script that a machine holding the Haiku key runs
 * (`ssh <host> 'bash -s' < script`; the key is read there from the server's own env file and never printed), `score` reads what came back. A run's records are read only.
 *
 *   tsx scripts/minecraft-descent-bench-1127k.ts build <records> <out.json> <old-end.txt> <new-end.txt> [--reps=5] [--scenes=d0245,d0279,d0305,d0310] [--groups=OLD,ABE,ALL]
 *   tsx scripts/minecraft-descent-bench-1127k.ts vm-script <out.json> <script.sh> [capUsd=0.15]
 *   ssh azure-constant-server 'bash -s' < script.sh > results.txt
 *   tsx scripts/minecraft-descent-bench-1127k.ts score <results.txt> <out.json>
 *
 * WHAT IS REBUILT: the End view is read back from the recorded facts' words (the dragon's line, the crystals', the waiting cells, the footing line's drop), and the height watch is replayed over the recorded decisions from the
 * first one on the top, with the acts that were sent (the waits in a row), so the minutes and the health lost are those of the run. The catalog the model sees is the recorded one with go's maxDrop said to take up to 70
 * (the body's new catalog is not made yet: the cap here is provisional). SAMPLES ARE FEW: a count says what happened in them, not a rate. The bench replays the head's input only.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { aloftBy, createHeightWatch, descentLine, dragonWaitLine, heightCtxOf, noBowLine, waitStreakLine, type HeightView } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { footingDropOf } from '../src/surfaces/minecraft/minecraftLlmcFooting.js';
import type { EndView } from '../src/surfaces/minecraft/minecraftEndView.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
interface Records { events: Json[]; blob(hash: string): unknown }
export function openRecords(dir: string): Records {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Json);
  return { events, blob: hash => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'blobs', `${hash}.json.gz`))).toString('utf8')) };
}
const idOf = (event: Json): string | null => { const ids = record(event.ids); return typeof ids?.decision === 'string' ? ids.decision : typeof event.decisionId === 'string' ? event.decisionId : null; };
const numberOf = (id: string) => Number(id.slice(1));

// ---------------------------------------------------------------------------------------------------- rebuild the view from the recorded words
interface Rebuilt { end: EndView; hp: number | null; world: Json; counts: Map<string, number>; at: number }
function parseInventory(items: string[]): { inventory: Json[]; counts: Map<string, number> } {
  const counts = new Map<string, number>(), inventory: Json[] = [];
  for (const text of items) {
    const m = /^([a-z_]+)×(\d+)(?:\(耐久(\d+)\/(\d+)\))?$/u.exec(text);
    if (!m) continue;
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + Number(m[2]));
    inventory.push({ name: m[1], count: Number(m[2]), ...(m[3] ? { durability: { left: Number(m[3]), max: Number(m[4]) } } : {}) });
  }
  return { inventory, counts };
}
function rebuild(rawText: string, at: number): Rebuilt | null {
  const raw = JSON.parse(rawText) as Json, body = record(raw.body);
  if (!body) return null;
  const facts = (Array.isArray(body.facts) ? body.facts : []).map(String), state = record(body.state) ?? {};
  const pos = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(String(state.at ?? ''));
  if (!pos) return null;
  const feet = { x: Number(pos[1]) + 0.5, y: Number(pos[2]), z: Number(pos[3]) + 0.5 };
  const dragonLine = facts.find(line => line.startsWith('竜:')) ?? '';
  const health = /体力 ([\d.]+)\/200/u.exec(dragonLine), phase = /phase (\d+)/u.exec(dragonLine), distance = /自分から (\d+)m/u.exec(dragonLine);
  const crystalLine = facts.find(line => line.startsWith('エンドクリスタル:')) ?? '';
  const remaining = /残り (\d+)\/10/u.exec(crystalLine), caged = /檻つき (\d+)/u.exec(crystalLine);
  const list = [...crystalLine.matchAll(/(?:#(\d+) )?\((-?\d+),(-?\d+),(-?\d+)\) (\d+)m( 檻つき)?/gu)].map(m => ({ id: m[1] ? Number(m[1]) : null, position: { x: Number(m[2]), y: Number(m[3]), z: Number(m[4]) },
    caged: !!m[6], distance: Number(m[5]), healing: false, blast: null }));
  const waitLine = facts.find(line => line.startsWith('待ち場の候補')) ?? '';
  const wait = [...waitLine.matchAll(/\((-?\d+),(-?\d+),(-?\d+)\)(?: 直線約 (\d+)m| 歩く約 ([\d.]+) 秒)?/gu)].map(m => ({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]),
    walkMeters: m[4] ? Number(m[4]) : null, walkSeconds: m[5] ? Number(m[5]) : null, side: 0, straight: !!m[4] }));
  const drop = footingDropOf(typeof body.footing === 'string' ? body.footing : null);
  const end = { feet, ...(drop !== null ? { drop } : {}),
    dragon: dragonLine ? { id: null, health: health ? Number(health[1]) : null, phase: phase ? Number(phase[1]) : null, phaseName: null, phaseFor: null, perched: false, position: null, headPosition: null,
      distance: distance ? Number(distance[1]) : null, headReach: null, strike: null, ...(wait.length ? { approach: { strike: [], stage: [], retreat: [], wait } } : {}) } : null,
    perch: { x: 0, y: 69, z: 0 }, crystals: { remaining: remaining ? Number(remaining[1]) : null, gone: null, caged: caged ? Number(caged[1]) : null, unseen: null, visible: null, list },
    breath: [], fireballs: 0 } as unknown as EndView;
  const { inventory, counts } = parseInventory((Array.isArray(body.inventory) ? body.inventory : []).map(String));
  const hp = typeof state.health === 'number' ? state.health : null;
  return { end, hp, world: { dimension: 'the_end', localMap: String(body.map ?? ''), inventory }, counts, at };
}

interface Scene { id: string; view: HeightView; ctx: ReturnType<typeof heightCtxOf>; rebuilt: Rebuilt }
/** Replays the watch from the first decision of the stay (decision 231 on) to each scene, so its minutes, hits and waits are the run's. */
function replay(records: Records, scenes: readonly string[], from = 231): Map<string, Scene> {
  const lives = records.events.filter(event => event.ev === 'live' && idOf(event) !== null).sort((a, b) => numberOf(idOf(a)!) - numberOf(idOf(b)!));
  const sent = records.events.filter(event => event.ev === 'sent');
  const watch = createHeightWatch(), out = new Map<string, Scene>();
  let fed = 0;
  for (const live of lives) {
    const id = idOf(live)!;
    if (numberOf(id) < from || numberOf(id) > Math.max(...scenes.map(numberOf))) continue;
    const at = Date.parse(String(live.at));
    const rebuilt = rebuild(String(live.raw), at);
    if (!rebuilt) continue;
    const ordered = sent.filter(event => Date.parse(String(event.at)) <= at);
    for (; fed < ordered.length; fed += 1) {
      const hands = record(ordered[fed]!.arguments)?.hands;
      watch.noteActs((Array.isArray(hands) ? hands : []).map(hand => String(record(hand)?.do ?? '')));
    }
    const view = watch.view(rebuilt.end, rebuilt.hp, at);
    if (scenes.includes(id)) out.set(id, { id, view, ctx: heightCtxOf(rebuilt.world, rebuilt.counts), rebuilt });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- build
interface Case { name: string; scene: string; group: 'OLD' | 'ABE' | 'ALL'; key: string; feet: { x: number; y: number; z: number } }
interface Built { notes: string[]; bodies: Record<string, Json>; headers: Record<string, Record<string, string>>; cases: Case[] }
const SCENES = ['d0245', 'd0279', 'd0305', 'd0310'];
const esc = (text: string): string => JSON.stringify(text).slice(1, -1);
const OLD_EVENT = 'この節にはもう新しい計画は来ない。同じ手を続けず、直近の結果から進まない理由を考え、自分で plan.update で節を割り直すか別の手段の節に替えるか、blocked にして別の節へ移る';
const NEW_EVENT = 'この節にはもう新しい計画は来ない（動かなくてよいという意味ではない: 手は自分で選ぶ）。同じ手（待つ・同じ go の出し直し）を続けない。次のどれかを選ぶ: ①今の入力にある別の手を出す（高所なら「高所:」の行の降りる手、地上なら待ち場・近づく手）、'
  + '②直近の結果から進まない理由を書き、plan.update で節を割り直すか別の手段の節に替える、③blocked にして別の節へ移る';
const OLD_DIAMOND = '残り少ないダイヤは黒曜石用に持ち続ける: 捨てない・空けない（体も最後の 1 本は投げない）。';
const NEW_DIAMOND = `${OLD_DIAMOND}ただし高所で降りる・逃げる命が先で、その時は黒曜石でなく降りるのに使ってよい。`;
const STONE_TAIL = '作り直すなら 丸石 3・棒 2）';
const STONE_ADD = '。ダイヤを端の石掘り（go の dig・縦穴の石の層）に使わない: 石の道具が尽きたら掘る手を減らし、丸石 3・棒 2 と作業台（板 4）が近くにあれば先に石のつるはしを作る。ダイヤの残りは黒曜石と、高所から降りる・逃げる分';

function textOf(message: Json): string { return typeof message.content === 'string' ? message.content : JSON.stringify(message.content); }
function mapText(message: Json, change: (text: string) => string): Json {
  if (typeof message.content === 'string') return { ...message, content: change(message.content) };
  return { ...message, content: (Array.isArray(message.content) ? message.content : []).map(block => { const item = record(block); return item && typeof item.text === 'string' ? { ...item, text: change(item.text) } : block; }) };
}

function build(dir: string, reps: number, scenes: readonly string[], oldEnd: string, newEnd: string, groups: readonly ('OLD' | 'ABE' | 'ALL')[]): Built {
  const records = openRecords(dir);
  const seen = replay(records, scenes);
  const notes: string[] = [], bodies: Record<string, Json> = {}, headers: Record<string, Record<string, string>> = {}, cases: Case[] = [];
  for (const id of scenes) {
    const scene = seen.get(id);
    if (!scene) { notes.push(`${id}: no scene`); continue; }
    const request = records.events.find(event => event.ev === 'request' && event.id === id);
    if (!request) throw new Error(`no request ${id}`);
    const config = request.config as Json, hdr = (request.headers ?? {}) as Record<string, string>;
    const system = records.blob(String(request.system));
    const toolsText = JSON.stringify(records.blob(String(request.tools)));
    const capped = toolsText.replace('maxDrop は一度に落ちてよい段（既定 3）。', 'maxDrop は一度に落ちてよい段（既定 3、最大 70。10 を超える値は水バケツで着水する飛び降り用）。');
    notes.push(`${id}: catalog maxDrop words ${capped !== toolsText}`);
    const tools = JSON.parse(capped) as unknown;
    const messages = (request.messages as string[]).map(hash => records.blob(hash) as Json);
    const last = messages[messages.length - 1]!;
    const live = JSON.parse(String(last.content)) as Json, body = record(live.body)!;
    const bodyOf = (msgs: Json[]): Json => ({ ...config, system, tools, messages: msgs });
    const make = (all: boolean): Json[] => {
      const next = JSON.parse(JSON.stringify(live)) as Json, nb = record(next.body)!;
      const facts = (Array.isArray(nb.facts) ? nb.facts : []).map(String);
      const drop = aloftBy(scene.view.end);
      const lead = [descentLine(scene.view.end, scene.view, scene.ctx), waitStreakLine(scene.view, drop !== null)].filter((line): line is string => line !== null);
      const noBowAt = facts.findIndex(line => line.startsWith('クリスタルの射点: 弓か矢が無い'));
      if (noBowAt >= 0 && drop !== null) facts[noBowAt] = noBowLine(scene.view.end, scene.view.sit);
      const dragonAt = facts.findIndex(line => line.startsWith('竜:'));
      facts.splice(dragonAt >= 0 ? dragonAt : facts.length, 0, ...lead);
      if (all) {
        const waitAt = facts.findIndex(line => line.startsWith('待ち場の候補'));
        const waitNew = dragonWaitLine(scene.view.end);
        if (waitAt >= 0 && waitNew) facts[waitAt] = waitNew;
        facts.forEach((line, index) => {
          if (line.includes(OLD_DIAMOND)) facts[index] = line.replace(OLD_DIAMOND, NEW_DIAMOND);
          if (line.startsWith('体は一番安い道具から使う設計') && line.endsWith(STONE_TAIL)) facts[index] = `${line}${STONE_ADD}`;
        });
      }
      nb.facts = facts;
      if (Array.isArray(nb.events)) nb.events = nb.events.map(line => String(line).replace(OLD_EVENT, NEW_EVENT));
      let msgs = [...messages.slice(0, -1), { ...last, content: JSON.stringify(next) }];
      if (all) {
        let replaced = 0;
        msgs = msgs.map(message => mapText(message, text => { const count = text.split(esc(oldEnd)).length - 1; replaced += count; return count ? text.split(esc(oldEnd)).join(esc(newEnd)) : text; }));
        notes.push(`${id}: the End knowledge replaced in ${replaced} message(s)`);
      }
      return msgs;
    };
    if (JSON.stringify(live) !== String(last.content)) notes.push(`${id}: the last message does not round-trip`);
    notes.push(`${id}: height ${drop(scene)}; ${JSON.stringify({ basis: scene.view.basis, minutes: scene.view.minutes, hits: scene.view.hits, lost: scene.view.lost, waits: scene.view.waits })}`);
    for (const group of groups) {
      const key = `${id}-${group}`;
      bodies[key] = bodyOf(group === 'OLD' ? messages.map((message, index) => index === messages.length - 1 ? { ...last, content: String(last.content) } : message) : make(group === 'ALL'));
      headers[key] = hdr;
      void body;
    }
    for (let n = 1; n <= reps; n += 1) for (const group of groups) cases.push({ name: `${id}-${group}-${n}`, scene: id, group, key: `${id}-${group}`, feet: scene.rebuilt.end.feet! });
  }
  // turn by turn, scene by scene, so that a stop at the cap leaves a fair comparison
  const ordered = Array.from({ length: reps }, (_, index) => cases.filter(item => item.name.endsWith(`-${index + 1}`))).flat();
  return { notes, bodies, headers, cases: ordered };
}
const drop = (scene: Scene): number | null => aloftBy(scene.view.end);

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
const parseHand = (value: unknown): Json | null => {
  if (typeof value !== 'string') return record(value);
  const text = value.trim().replace(/^json\s+/u, '');
  if (text.startsWith('{')) { try { return record(JSON.parse(text)); } catch { return null; } }
  const [kind, ...rest] = text.split(/\s+/u);
  const hand: Json = { do: kind };
  for (const part of rest) {
    if (part === 'up' || part === 'down') { hand.dir = part; continue; }
    const xyz = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u.exec(part);
    if (xyz) { hand.goals = [{ x: Number(xyz[1]), y: Number(xyz[2]), z: Number(xyz[3]) }]; continue; }
    const eq = part.indexOf('=');
    if (eq > 0) { const raw = part.slice(eq + 1); hand[part.slice(0, eq)] = Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : raw; }
  }
  return hand;
};
export interface Read { tool: string | null; hands: string[]; jump: boolean; digDown: boolean; toGround: boolean; strike: boolean; climbUp: boolean; waitOnly: boolean; scaffold: boolean; why: string }
/** What the answer's first call does, counted as the bench's questions ask. */
export function classify(blocks: unknown, feet: { x: number; y: number; z: number }): Read {
  const calls = (Array.isArray(blocks) ? blocks : []).map(record).filter((block): block is Json => block?.type === 'tool_use');
  const call = calls[0];
  const empty = { hands: [], jump: false, digDown: false, toGround: false, strike: false, climbUp: false, waitOnly: false, scaffold: false, why: '' };
  if (!call) return { tool: null, ...empty };
  const input = record(call.input) ?? {};
  if (call.name !== 'mc_act') return { tool: String(call.name), ...empty };
  const hands = (Array.isArray(input.hands) ? input.hands : []).map(parseHand).filter((hand): hand is Json => hand !== null);
  const read: Read = { tool: 'mc_act', ...empty, hands: hands.map(hand => String(hand.do)), why: String(input.why ?? '').slice(0, 110) };
  for (const hand of hands) {
    const goal = (Array.isArray(hand.goals) ? hand.goals : []).map(record)[0] ?? record(hand.to);
    if (hand.do === 'go') {
      if (typeof hand.maxDrop === 'number' && hand.maxDrop >= 11) read.jump = true;
      if (goal && typeof goal.y === 'number' && goal.y <= feet.y - 10) read.toGround = true;
    }
    if (hand.do === 'vertical' && (hand.dir === 'down' || (typeof hand.toY === 'number' && hand.toY < feet.y - 5))) read.digDown = true;
    if (hand.do === 'vertical' && hand.dir === 'up') read.climbUp = true;
    if (hand.do === 'attack' || hand.do === 'use' || (hand.do === 'place' && /bed/u.test(JSON.stringify(hand)))) read.strike = true;
  }
  read.waitOnly = hands.length > 0 && hands.every(hand => hand.do === 'wait' || hand.do === 'sleep');
  return read;
}
interface Result { name: string; model?: string; costUsd?: number; blocks?: Json[]; skipped?: string; failed?: string; error?: string }
function score(resultsFile: string, casesFile: string): unknown {
  const cases = new Map((JSON.parse(fs.readFileSync(casesFile, 'utf8')) as Built).cases.map(item => [item.name, item]));
  const results = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Result);
  const rows = results.map(result => {
    const item = cases.get(result.name)!;
    if (!result.blocks) return { name: result.name, scene: item.scene, group: item.group, note: result.skipped ?? result.failed ?? result.error ?? 'no answer' };
    return { name: result.name, scene: item.scene, group: item.group, costUsd: result.costUsd, ...classify(result.blocks, item.feet) };
  });
  const groups = [...new Set(rows.map(row => `${row.scene}-${row.group}`))];
  const summary = groups.map(group => {
    const mine = rows.filter(row => `${row.scene}-${row.group}` === group && !('note' in row)) as Array<Read & { costUsd?: number }>;
    const count = (pick: (row: Read) => boolean) => mine.filter(pick).length;
    return { group, n: mine.length, skipped: rows.filter(row => `${row.scene}-${row.group}` === group && 'note' in row).length,
      comesDown: count(row => row.jump || row.digDown || row.toGround), jump: count(row => row.jump), digDown: count(row => row.digDown), toGround: count(row => row.toGround),
      strike: count(row => row.strike), climbUp: count(row => row.climbUp), waitOnly: count(row => row.waitOnly), costUsd: Number(mine.reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(4)) };
  });
  return { summary, rows };
}

async function main(argv: string[]): Promise<void> {
  const [mode, a, b, c, d] = argv.filter(arg => !arg.startsWith('--'));
  const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (mode === 'build' && a && b && c && d) {
    const out = build(a, Number(flag('reps') ?? 5), flag('scenes')?.split(',') ?? SCENES, fs.readFileSync(c, 'utf8'), fs.readFileSync(d, 'utf8'),
      (flag('groups')?.split(',') ?? ['OLD', 'ABE', 'ALL']) as ('OLD' | 'ABE' | 'ALL')[]);
    fs.writeFileSync(b, JSON.stringify(out, null, 1));
    out.notes.forEach(note => console.log(`NOTE ${note}`));
    console.log(`cases ${out.cases.length}`);
  } else if (mode === 'vm-script' && a && b) {
    fs.writeFileSync(b, vmScript(a, Number(c ?? 0.15)));
    console.log('script written');
  } else if (mode === 'score' && a && b) {
    const out = score(a, b.replace(/\.json$/u, '') === b ? b : b);
    console.log(JSON.stringify(out, null, 1));
  } else {
    console.log('usage: build <records> <out.json> <old-end.txt> <new-end.txt> | vm-script <out.json> <script.sh> [cap] | score <results.txt> <built.json>');
  }
}
if (process.argv[1]?.includes('minecraft-descent-bench-1127k')) void main(process.argv.slice(2));
