/**
 * A throwaway bench of the first plan (11/27, run 8: with 11 eyes in the pack Haiku wrote the village's beds, iron, an obsidian node and a bow before the stronghold). Never run by the
 * tests. It asks no model itself: `build` makes the requests (the cases below), `vm-script` wraps them in one LF shell script that a machine holding the Haiku key runs
 * (`ssh <host> 'bash -s' < script`; the key is read there from the server's own env file and never printed), and `score` reads what came back.
 *
 *   tsx scripts/minecraft-firstplan-bench-1127b.ts build <dir> <out.json>        dir: run8_system.txt run8_user.txt run8_pack.json run8_request.json run7_user.txt run7_pack.json
 *   tsx scripts/minecraft-firstplan-bench-1127b.ts vm-script <out.json> <script.sh> [capUsd]
 *   tsx scripts/minecraft-firstplan-bench-1127b.ts score <results.jsonl> <cases.json>
 *
 * The cases (the order they are asked in, so that a stop at the cap leaves a fair comparison):
 *   i  (control)  run 8's own request, replayed as it was (the old system, the old shortage line, the pack cut at 800 characters).
 *   ii            run 8's input made again by the code of this tree (the new system, the whole pack, the finished things, the eyes line as facts, the facts side's shortage line);
 *                 the scan, the map and the places are run 8's own lines.
 *   iii           run 7's input (in the Nether with 13 eyes) made by this tree.
 *   iv            a new world (no eyes, an empty pack, the opening draft) made by this tree.
 * What is counted: the stronghold node's place among the top-level nodes after `strongholdFirst` (what the run keeps), whether an iron stock node is there (a `have:iron_ingot>=n` condition),
 * and for iv whether the ordinary opening order (village, food, iron, ... before the stronghold) is kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eyesForStronghold, firstPlanInput, openingDraft, seedPlan, strongholdFirst } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';

const GOAL = 'エンドラを討伐して';
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const TRANSPORT_END = 'あなたはマイクラの体のタスクの、最初の計画ツリーを立てる係';
const TAIL_FROM = '走査（読み込み済みの範囲の目印）:';

function stackOf(text: string): Record<string, unknown> {
  const found = /^(.+?)×(\d+)(?:\(耐久(\d+)\/(\d+)\))?$/u.exec(text)!;
  return { name: found[1], count: Number(found[2]), ...(found[3] ? { durability: { left: Number(found[3]), max: Number(found[4]) } } : {}) };
}
const lineOf = (user: string, head: string) => user.split('\n').find(line => line.startsWith(head))?.slice(head.length) ?? '';

/** The world of an old input (its own lines), with the whole pack in place of the cut one. */
function worldOfUser(user: string, pack: string[]): Record<string, unknown> {
  return { position: JSON.parse(lineOf(user, '位置: ')), dimension: lineOf(user, 'ディメンション: '), biome: lineOf(user, 'バイオーム: '), time: lineOf(user, '時刻: '),
    inventory: pack.map(stackOf), worn: lineOf(user, '着ている物: '), health: 20, food: 20 };
}
/** The new top of the input (everything before the scan) and the old input's own scan, map and places. */
function rebuilt(oldUser: string, pack: string[], now: number): { user: string; world: Record<string, unknown> } {
  const world = worldOfUser(oldUser, pack);
  const top = firstPlanInput(GOAL, world, { readiness: true, journeyReadiness: true, now });
  const tail = oldUser.slice(oldUser.indexOf(TAIL_FROM));
  return { user: `${top}\n${tail}`, world };
}

interface Case { name: string; group: 'i' | 'ii' | 'iii' | 'iv'; system: string; user: string; eyes: number | null }

function build(dir: string): { config: unknown; cases: Case[] } {
  const request = JSON.parse(read(dir, 'run8_request.json')) as { config: Record<string, unknown> };
  const oldSystem = read(dir, 'run8_system.txt');
  const oldUser8 = read(dir, 'run8_user.txt').replace(/^\[user\]\n/u, '');
  const oldUser7 = read(dir, 'run7_user.txt').replace(/^\[user\]\n/u, '');
  const transport = oldSystem.slice(0, oldSystem.indexOf(TRANSPORT_END));
  const system = `${transport}${ownFirstPlanSystem()}`;
  const now = Date.parse('2026-11-26T17:29:22Z');
  const run8 = rebuilt(oldUser8, JSON.parse(read(dir, 'run8_pack.json')) as string[], now);
  const run7 = rebuilt(oldUser7, JSON.parse(read(dir, 'run7_pack.json')) as string[], now);
  const fresh = { position: { x: 12.5, y: 70, z: 8.5 }, dimension: 'overworld', biome: 'plains', time: '1000', health: 20, food: 20, inventory: [] };
  const freshInput = firstPlanInput(GOAL, fresh, { readiness: true, journeyReadiness: true, draft: openingDraft(seedPlan(GOAL, 'overworld')), now });
  const cases: Case[] = [];
  for (let n = 1; n <= 3; n += 1) {
    cases.push({ name: `i-${n}`, group: 'i', system: oldSystem, user: oldUser8, eyes: eyesForStronghold(worldOfUser(oldUser8, JSON.parse(read(dir, 'run8_pack.json')) as string[])) });
    cases.push({ name: `ii-${n}`, group: 'ii', system, user: run8.user, eyes: eyesForStronghold(run8.world) });
  }
  for (let n = 1; n <= 2; n += 1) cases.push({ name: `iii-${n}`, group: 'iii', system, user: run7.user, eyes: eyesForStronghold(run7.world) });
  cases.push({ name: 'iv-1', group: 'iv', system, user: freshInput, eyes: eyesForStronghold(fresh) });
  const keep = ['model', 'max_tokens', 'thinking', 'output_config'];
  return { config: Object.fromEntries(keep.map(key => [key, request.config[key]])), cases };
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
  for (const item of input.cases) {
    if (spent >= input.cap) { console.log('RESULT ' + JSON.stringify({ name: item.name, skipped: 'cap', spent })); continue; }
    const body = { ...input.config, system: [{ type: 'text', text: item.system }], messages: [{ role: 'user', content: [{ type: 'text', text: item.user }] }] };
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 170000);
    const began = Date.now();
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: abort.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await response.json();
      const usage = json.usage || {};
      const cost = ((usage.input_tokens || 0) * 0.1 + (usage.output_tokens || 0) * 0.5 + (usage.cache_creation_input_tokens || 0) * 0.125 + (usage.cache_read_input_tokens || 0) * 0.01) / 1e6;
      spent += cost;
      const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      console.log('RESULT ' + JSON.stringify({ name: item.name, status: response.status, stop: json.stop_reason, ms: Date.now() - began, usage, costUsd: cost, spent, text,
        error: response.ok ? undefined : (json.error && json.error.type) }));
    } catch (error) {
      console.log('RESULT ' + JSON.stringify({ name: item.name, failed: String(error && error.name || error), ms: Date.now() - began, spent }));
    } finally { clearTimeout(timer); }
  }
});
`;

function vmScript(outJson: string, cap: number): string {
  const payload = Buffer.from(JSON.stringify({ cap, ...(JSON.parse(fs.readFileSync(outJson, 'utf8')) as object) }), 'utf8').toString('base64');
  return ['#!/usr/bin/env bash', 'set -u', `PAYLOAD='${payload}'`, "read -r -d '' JS <<'JSEOF'", NODE_RUNNER.trim(), 'JSEOF', 'printf \'%s\' "$PAYLOAD" | base64 -d | node -e "$JS"', ''].join('\n');
}

interface Result { name: string; text?: string; costUsd?: number; usage?: { output_tokens?: number }; skipped?: string; failed?: string }
function score(resultsFile: string, casesFile: string): unknown[] {
  const cases = (JSON.parse(fs.readFileSync(casesFile, 'utf8')) as { cases: Case[] }).cases;
  const results = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Result);
  return results.map(result => {
    const spec = cases.find(item => item.name === result.name)!;
    if (!result.text) return { name: result.name, note: result.skipped ?? result.failed ?? 'no text' };
    const answer = strongholdFirst(JSON.parse(result.text), spec.eyes) as { nodes: Array<{ id: string; parent: string; title: string; kind: string; doneWhen?: string; where?: string }> };
    const tops = answer.nodes.filter(node => !node.parent);
    const stronghold = tops.findIndex(node => node.kind === 'stronghold');
    const ironStock = answer.nodes.some(node => node.kind === 'iron' && /have:iron_ingot>=\d+/u.test(node.doneWhen ?? ''));
    const kinds = tops.map(node => node.kind);
    const before = (kind: string) => { const at = kinds.indexOf(kind); return at < 0 ? null : at; };
    return { name: result.name, group: spec.group, tops: tops.length, strongholdPosition: stronghold < 0 ? null : stronghold + 1, beforeStronghold: stronghold < 0 ? null : kinds.slice(0, stronghold),
      ironStock, where: answer.nodes.filter(node => node.where).map(node => node.where).slice(0, 6),
      order: { village: before('village'), iron: before('iron'), nether: before('nether') ?? before('portal'), stronghold: stronghold < 0 ? null : stronghold },
      titles: tops.map(node => `${node.id} ${node.title}`), costUsd: result.costUsd, outputTokens: result.usage?.output_tokens };
  });
}

const [mode, a, b, c] = process.argv.slice(2);
if (mode === 'build' && a && b) {
  const out = build(a);
  fs.writeFileSync(b, JSON.stringify(out, null, 1));
  for (const item of out.cases) fs.writeFileSync(`${b}.${item.name}.user.txt`, item.user);
  console.log(`cases ${out.cases.map(item => `${item.name}(${item.system.length}+${item.user.length})`).join(' ')}`);
} else if (mode === 'vm-script' && a && b) {
  fs.writeFileSync(b, vmScript(a, Number(c ?? 0.1)));
  console.log('script written');
} else if (mode === 'score' && a && b) {
  console.log(JSON.stringify(score(a, b), null, 1));
} else {
  console.error('usage: build <dir> <out.json> | vm-script <out.json> <script.sh> [capUsd] | score <results.jsonl> <cases.json>');
  process.exit(2);
}
