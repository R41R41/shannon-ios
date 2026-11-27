/**
 * A throwaway bench of the head against the real Haiku for the spare eyes (a run's d0039 and d0042: eyes 11, the stronghold's crossing 150 to 225 m ahead, two broken throws on the
 * ledger, no pearl: the head walked to the crossing, threw and ran short of the frames by one). Never run by the tests. Same shape as the 1127c bench (this file is its copy with the
 * decisions, the world's throw record and the readings changed): `snapshot` in the tree BEFORE the fix, `build --group=A|B` (B with `--base`), `vm-script`, `score`.
 * Group A is the recorded request as it was; group B has the parts this tree makes (the act's system, planNow, the shortage; the first plan's system and its lines) spliced in
 * only where the base tree's string is found in the recorded text. The first plan has two scenes: the recorded one (eyes in the pack) and a new world.
 * COUNTED (act): the first hand's kind, whether any hand throws an eye, whether the why or the hands mention a spare / a break / a pearl, whether a go turns back from the frontier (z < 1100).
 * (plan): the nodes' counts of rods, pearls and eyes (a number that is out of reach shows here). SAMPLES ARE FEW (6 to 9 a group): a count says what happened in them, not a rate.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const GOAL = 'エンドラを討伐して';
const TRANSPORT_END = 'あなたはマイクラの体のタスクの、最初の計画ツリーを立てる係';
const HOUR = { type: 'ephemeral', ttl: '1h' } as const;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

// ---------------------------------------------------------------------------------------------------- pure parts (tested)

/**
 * `recorded` with the part the OLD tree made (`oldPart`) put right by the NEW tree's (`newPart`): the whole text when it is the old part; the old part inside it when it holds it
 * (once); null when the old part is not in it (the rebuild does not read this input as the run did: nothing is changed).
 */
export function spliceFrom(recorded: string, oldPart: string | null | undefined, newPart: string | null | undefined): string | null {
  if (typeof oldPart !== 'string' || !oldPart || typeof newPart !== 'string') return null;
  if (recorded === oldPart) return newPart;
  const at = recorded.indexOf(oldPart);
  if (at < 0 || recorded.indexOf(oldPart, at + 1) >= 0) return null;
  return `${recorded.slice(0, at)}${newPart}${recorded.slice(at + oldPart.length)}`;
}

/**
 * The recorded text holds lines the rebuild cannot make (the furnace line reads the map): it is `oldWhole` with a gap put in before `marker`. When it is shaped so (the head and the tail of
 * `oldWhole` around the marker are its own), the gap is kept and the new head and tail go around it. Null otherwise.
 */
export function spliceAroundGap(recorded: string, oldWhole: string | null | undefined, newWhole: string | null | undefined, marker: string): string | null {
  if (typeof oldWhole !== 'string' || typeof newWhole !== 'string' || !marker) return null;
  const was = oldWhole.indexOf(marker), now = newWhole.indexOf(marker);
  if (was < 0 || now < 0 || oldWhole.indexOf(marker, was + 1) >= 0) return null;
  const head = oldWhole.slice(0, was), tail = oldWhole.slice(was);
  if (recorded.length < oldWhole.length || !recorded.startsWith(head) || !recorded.endsWith(tail)) return null;
  return `${newWhole.slice(0, now)}${recorded.slice(head.length, recorded.length - tail.length)}${newWhole.slice(now)}`;
}

const CROSSING_Z = 900;
export interface ActRead { tool: string | null; first: string; node: string | null; klass: 'p1' | 'p2' | 'probe' | 'view' | 'plan_update' | 'wait' | 'other' | 'none'; tools: string[];
  /** The owner's three-way reading (a missing iron armour is rightly made before leaving, so p1 alone is not the success): good_stronghold / good_fill (a short fill from the pack) / bad_checklist (the End's checklist or the village trip) / neutral (a wait, a probe) / other. A first reading by words and places: read `why` by eye. */
  verdict: string }
const PLACE_KEYS = ['to', 'at', 'goals', 'path'];
function places(value: unknown, into: Array<{ x: number; z: number }> = []): Array<{ x: number; z: number }> {
  if (Array.isArray(value)) value.forEach(item => places(item, into));
  else { const item = record(value); if (item) { if (typeof item.x === 'number' && typeof item.z === 'number') into.push({ x: item.x, z: item.z }); PLACE_KEYS.forEach(key => places(item[key], into)); } }
  return into;
}
/** What the answer's first call is: its tool, its first hand, the node its `why` names and the class counted. `blocks` are the answer's content blocks. */
export function classifyAct(blocks: unknown): ActRead {
  const calls = (Array.isArray(blocks) ? blocks : []).map(record).filter((block): block is Json => block?.type === 'tool_use');
  const tools = calls.map(call => String(call.name));
  const call = calls[0];
  if (!call) return { tool: null, first: '', node: null, klass: 'none', tools, verdict: 'none' };
  const name = String(call.name), input = record(call.input) ?? {};
  if (name !== 'mc_act') return { tool: name, first: '', node: null, klass: name === 'mc_probe' ? 'probe' : name === 'mc_view' ? 'view' : name === 'plan_update' ? 'plan_update' : 'other', tools,
    verdict: name === 'mc_probe' || name === 'mc_view' ? 'neutral' : 'other' };
  const hands = (Array.isArray(input.hands) ? input.hands : []).map(record).filter((hand): hand is Json => hand !== null);
  const why = typeof input.why === 'string' ? input.why : '';
  const node = /^\[(p[\d.]+)\]/u.exec(why)?.[1] ?? null;
  const first = hands[0] ? String(hands[0].do) : '';
  const toward = hands.some(hand => places(hand).some(place => place.z >= CROSSING_Z));
  const idle = hands.length > 0 && hands.every(hand => ['sleep', 'wait'].includes(String(hand.do)));
  const klass: ActRead['klass'] = node?.startsWith('p1') || toward ? 'p1' : node?.startsWith('p2') ? 'p2' : idle ? 'wait' : 'other';
  const villageNear = hands.some(hand => places(hand).some(place => Math.hypot(place.x - 199, place.z + 147) < 160 || Math.hypot(place.x - 231, place.z + 128) < 160));
  const checklist = /ベッド|黒曜石|足場|弓|矢|矢を|bed|obsidian|arrow|scaffold/iu.test(why), fill = /レギンス|ブーツ|防具|兜|胸当て|食料|食べ|つるはし|ツルハシ|pickaxe|armou?r|leggings|boots/iu.test(why);
  const verdict = klass === 'p1' || /要塞|交点|アイを投げ/u.test(why) ? 'good_stronghold' : idle ? 'neutral' : villageNear || checklist ? 'bad_checklist' : fill ? 'good_fill' : 'other';
  return { tool: name, first, node, klass, tools, verdict };
}
/** Which armour pieces the input's own state shows worn ("頭: iron_helmet…、脚: なし"), from a live's `body.state.worn`. */
export function armourWorn(worn: unknown): Record<string, boolean> {
  return Object.fromEntries([['helmet', '頭'], ['chestplate', '胴'], ['leggings', '脚'], ['boots', '足']].map(([slot, label]) => [slot, new RegExp(`${label}: (?!なし)`, 'u').test(String(worn ?? ''))]));
}

export interface PlanNodeRow { id: string; parent: string; title: string; kind: string; doneWhen?: string; where?: string }
export interface PlanRead { nodes: number; strongholdRaw: number | null; strongholdKept: number | null; portalWritten: boolean; portalKept: boolean; obsidianWritten: boolean; obsidianKept: boolean;
  atWritten: boolean; firstKind: string | null; order: Record<string, number | null> }
/** What a first plan's answer is, before (`written`) and after (`kept`, what `strongholdFirst` leaves) the code's own drop of the stages that make eyes. */
export function readPlan(written: readonly PlanNodeRow[], kept: readonly PlanNodeRow[]): PlanRead {
  const place = (rows: readonly PlanNodeRow[]) => { const at = rows.findIndex(node => node.kind === 'stronghold'); return at < 0 ? null : at + 1; };
  const has = (rows: readonly PlanNodeRow[], kind: string) => rows.some(node => node.kind === kind);
  const index = (kind: string) => { const at = kept.findIndex(node => node.kind === kind); return at < 0 ? null : at + 1; };
  return { nodes: kept.length, strongholdRaw: place(written), strongholdKept: place(kept), portalWritten: has(written, 'portal'), portalKept: has(kept, 'portal'),
    obsidianWritten: has(written, 'obsidian'), obsidianKept: has(kept, 'obsidian'), atWritten: written.some(node => /(^|[^a-z])at:/u.test(node.doneWhen ?? '')),
    firstKind: kept[0]?.kind ?? null, order: { village: index('village'), iron: index('iron'), nether: index('nether') ?? index('portal'), stronghold: index('stronghold') } };
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function stackOf(text: string): Json {
  const found = /^(.+?)×(\d+)(?:\(耐久(\d+)\/(\d+)\))?$/u.exec(text);
  if (!found) throw new Error(`pack entry unreadable: ${text}`);
  return { name: found[1], count: Number(found[2]), ...(found[3] ? { durability: { left: Number(found[3]), max: Number(found[4]) } } : {}) };
}
const lineOf = (user: string, head: string) => user.split('\n').find(line => line.startsWith(head))?.slice(head.length) ?? '';
/** The world of a first plan's recorded input, from its own lines. */
export function worldOfPlanUser(user: string): Json {
  const pack = lineOf(user, '持ち物: ');
  return { position: JSON.parse(lineOf(user, '位置: ')), dimension: lineOf(user, 'ディメンション: '), biome: lineOf(user, 'バイオーム: '), time: lineOf(user, '時刻: '),
    inventory: pack ? pack.split('・').map(stackOf) : [], worn: lineOf(user, '着ている物: '), health: 20, food: 20 };
}
/** The world of a live state's own fields (`body.inventory`, `body.state`), for the readiness functions. */
export function worldOfLive(body: Json): Json {
  const state = record(body.state) ?? {};
  const at = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(String(state.at ?? ''));
  return { position: at ? { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) } : undefined, dimension: state.dimension ?? 'overworld', biome: state.biome,
    inventory: (Array.isArray(body.inventory) ? body.inventory : []).map(item => stackOf(String(item))), worn: state.worn, health: state.health, food: state.fullness };
}

// ---------------------------------------------------------------------------------------------------- the run's records (read only)

interface Records { events: Json[]; blob(hash: string): unknown }
export function openRecords(dir: string): Records {
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
const textOfBlocks = (system: unknown): string[] => (Array.isArray(system) ? system : []).map(block => String(record(block)?.text ?? ''));

// ---------------------------------------------------------------------------------------------------- this tree's strings

/** What this tree makes of a run's inputs. Dynamic imports: the pure parts above are tested without the whole tree. */
async function treeParts(records: Records, decisions: readonly string[]) {
  const { minecraftV2Hooks } = await import('../src/surfaces/minecraft/minecraftLlmcV2.js');
  const { minecraftProfile } = await import('../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js');
  const { ownFirstPlanSystem } = await import('../src/surfaces/minecraft/minecraftStrategy.js');
  const { planFromAnswer, strongholdFirst, eyesForStronghold } = await import('../src/surfaces/minecraft/minecraftFirstPlan.js');
  const { readinessParts } = await import('../src/surfaces/minecraft/minecraftLlmcBodyFacts.js');
  const { preparationShortage } = await import('../src/surfaces/minecraft/minecraftLlmcReadiness.js');
  const { carriedItemCounts } = await import('../src/surfaces/minecraft/minecraftItems.js');
  const { carriedFood } = await import('../src/surfaces/minecraft/minecraftLlmcLive.js');

  const profile = minecraftProfile({ minecraftOwnPrompt: true, minecraftV2: minecraftV2Hooks() })!;
  const planRequest = recordedRequest(records, 'p0001');
  const planUser = String(planRequest.messages[0]!.content);
  const planWorld = worldOfPlanUser(planUser);
  const counts = carriedItemCounts(planWorld as never, {} as never);
  const planPrep = preparationShortage({ dimension: String(planWorld.dimension), counts, food: carriedFood(planWorld as never, {} as never).points, nowKinds: null, world: planWorld as never, journeyReadiness: true } as never);
  // The tree the run adopted: the recorded answer, with the code's own drop of the eye-making stages (`strongholdFirst`), as `planFromAnswer` takes it.
  const answerBlocks = records.blob(String(records.events.find(event => event.ev === 'response' && event.id === 'p0001')!.content)) as Json[];
  const answerText = String(answerBlocks.find(block => block.type === 'text')?.text ?? '');
  const answer = JSON.parse(answerText);
  const tree = planFromAnswer(strongholdFirst(answer, eyesForStronghold(planWorld as never)), undefined);
  const acts: Record<string, { planNow: string | null; shortage: string | null; prep: string | null }> = {};
  for (const id of decisions) {
    const live = recordedRequest(records, id).live;
    const body = record(live?.body);
    if (!body || !tree) { acts[id] = { planNow: null, shortage: null, prep: null }; continue; }
    const world = { ...worldOfLive(body), eyeThrows: throwsFor(id) };
    const now = String(record(record(body.planFacts)?.now)?.id ?? tree.current ?? '');
    const held = { ...tree, current: tree.nodes.some(node => node.id === now) ? now : tree.current };
    const observation = { schemaVersion: 1, bodyId: 'minecraft:replay', sequence: 1, stateAt: new Date(0).toISOString(), receivedAt: new Date(0).toISOString(), connected: true,
      state: { world }, facts: { alive: true, dimension: world.dimension } } as never;
    const llmc = { journeyReadiness: true, plan: () => undefined, planView: () => null, planTree: () => held } as never;
    const nodeNow = held.nodes.find(node => node.id === held.current);
    const path = nodeNow ? ancestors(held.nodes, nodeNow.id) : [];
    const made = readinessParts(llmc, { path } as never, observation);
    const counts2 = carriedItemCounts(world as never, {} as never);
    const prep = preparationShortage({ dimension: String(world.dimension), counts: counts2, food: carriedFood(world as never, {} as never).points, nowKinds: null, world: world as never, journeyReadiness: true } as never);
    acts[id] = { planNow: made.planNow ?? null, shortage: made.shortage ?? null, prep: prep ?? null };
  }
  return { actProtocol: profile.protocol, actTransient: profile.transient, planSystem: ownFirstPlanSystem(), planPrep: planPrep ?? null, acts };
}
function ancestors(nodes: ReadonlyArray<{ id: string; title: string; parentId?: string | null }>, id: string): string[] {
  const out: string[] = [];
  let at = nodes.find(node => node.id === id)?.parentId ?? null;
  while (at) { const node = nodes.find(item => item.id === at); if (!node) break; out.unshift(node.title); at = node.parentId ?? null; }
  return out;
}

// ---------------------------------------------------------------------------------------------------- cases

interface Case { name: string; kind: 'act' | 'plan'; group: string; label: string; key: string; eyes?: number | null; armourWorn?: Record<string, boolean> }
interface Built { notes: string[]; bodies: Record<string, Json>; headers: Record<string, Record<string, string>>; cases: Case[] }

const ACT_DECISIONS = ['d0039', 'd0042'];
/** The body's own record of the throws at each decision (the ledger's lines of the live state: two broken at the portal, a third that landed, from d0042). */
const RECORDED_THROWS = [
  { dim: 'overworld', x: 197, z: -245, yawDeg: 171.2, flewM: 12, broke: true, atMs: Date.parse('2026-11-27T01:20:10Z') },
  { dim: 'overworld', x: 176, z: -241, yawDeg: 170.5, flewM: 12, broke: true, atMs: Date.parse('2026-11-27T01:22:30Z') },
  { dim: 'overworld', x: 438, z: 1312, yawDeg: 171.2, flewM: 12, broke: false, atMs: Date.parse('2026-11-27T01:43:00Z') },
];
const throwsFor = (id: string) => RECORDED_THROWS.slice(0, id === 'd0039' ? 2 : 3);
function actBody(request: RecordedRequest, overrides: { system?: unknown; messages?: RecordedRequest['messages']; tools?: unknown }): Json {
  return { ...request.config, system: overrides.system ?? request.system, ...((overrides.tools ?? request.tools) ? { tools: overrides.tools ?? request.tools } : {}), messages: overrides.messages ?? request.messages };
}

async function build(recordsDir: string, options: { reps: number; planReps: number; group: 'A' | 'B'; base?: Json; tools?: unknown }): Promise<Built> {
  const records = openRecords(recordsDir);
  const notes: string[] = [];
  const bodies: Record<string, Json> = {}, headers: Record<string, Record<string, string>> = {};
  const cases: Case[] = [];
  const mine = await treeParts(records, ACT_DECISIONS);
  const base = options.base as { actTransient?: string; actProtocol?: string; planSystem?: string; planPrep?: string | null; acts?: Record<string, { planNow: string | null; shortage: string | null; prep: string | null }> } | undefined;
  if (options.group === 'B' && !base) throw new Error('group B needs --base (the snapshot of the tree before the fixes)');
  const B = options.group === 'B';
  const label = (name: string) => `${options.group}-${name}`;

  // act
  for (const id of ACT_DECISIONS) {
    const request = recordedRequest(records, id);
    let system: unknown = request.system;
    let messages = request.messages;
    if (B) {
      const texts = textOfBlocks(request.system);
      const protocol = spliceFrom(texts[0] ?? '', base!.actProtocol, mine.actProtocol), transient = spliceFrom(texts[1] ?? '', base!.actTransient, mine.actTransient);
      if (protocol === null || transient === null) notes.push(`${id}: the act's system is not the base tree's text (protocol ${protocol !== null}, instructions ${transient !== null}): left as recorded`);
      system = (request.system as Json[]).map((block, index) => index === 0 && protocol !== null ? { ...block, text: protocol } : index === 1 && transient !== null ? { ...block, text: transient } : block);
      const last = messages[messages.length - 1]!;
      const liveText = typeof last.content === 'string' ? last.content : '';
      let live: Json | null = null;
      try { live = JSON.parse(liveText) as Json; } catch { /* not a live message */ }
      if (live && JSON.stringify(live) !== liveText) { notes.push(`${id}: the recorded live does not round-trip through JSON: left as recorded`); live = null; }
      const body = record(live?.body);
      if (live && body) {
        const was = base!.acts?.[id], now = mine.acts[id]!;
        const planNow = typeof body.planNow === 'string' ? spliceFrom(body.planNow, was?.planNow, now.planNow) : null;
        // the whole shortage text when the run's is the one the rebuild makes; else only the preparation line (the other lines read the map and the furnaces, which the record does not hold)
        const shortage = typeof body.shortage === 'string' ? spliceFrom(body.shortage, was?.shortage, now.shortage) ?? spliceAroundGap(body.shortage, was?.shortage, now.shortage, 'エンドへ入る前に要る物のうち足りない分') ?? spliceFrom(body.shortage, was?.prep, now.prep) : null;
        if (planNow === null) notes.push(`${id}: planNow was not rebuilt (the base tree's planNow is not in the recorded one): left as recorded`);
        if (shortage === null) notes.push(`${id}: shortage was not rebuilt (the base tree's shortage is not in the recorded one): left as recorded`);
        const next = { ...live, body: { ...body, ...(planNow !== null ? { planNow } : {}), ...(shortage !== null ? { shortage } : {}) } };
        messages = [...messages.slice(0, -1), { ...last, content: JSON.stringify(next) }];
      } else notes.push(`${id}: the last message is not a live state: left as recorded`);
    }
    const key = `act-${id}-${options.group}`;
    bodies[key] = actBody(request, { system, messages, tools: options.tools });
    headers[key] = request.headers;
    for (let n = 1; n <= options.reps; n += 1) cases.push({ name: `${label(id)}-${n}`, kind: 'act', group: `${options.group}:${id}`, label: id, key, armourWorn: armourWorn(record(record(request.live?.body)?.state)?.worn) });
  }

  // the first plan
  const planRequest = recordedRequest(records, 'p0001');
  const planConfig = planRequest.config;
  const planUser = String(planRequest.messages[0]!.content);
  // Both groups use the strategy text of the tree that builds them (group A is built in the tree before the fix, group B in this tree): the recorded run's own strategy block is an older
  // text than either (the base tree's text is not found in it), so a splice cannot be done; the transport block (the first) stays as recorded.
  const blocks = planRequest.system as Json[];
  const planSystem: unknown = blocks.map((block, index) => index === 1 ? { ...block, text: mine.planSystem } : block);
  if (blocks.length < 2) notes.push('plan: the recorded system has no second block: left as recorded');
  // the scene of the recorded first plan: the recorded world (11 eyes, a powder, no pearl) with the body's record of the two throws made before it, built by the tree
  const { firstPlanInput: planInputOf, openingDraft: draftOf, seedPlan: seedOf } = await import('../src/surfaces/minecraft/minecraftFirstPlan.js');
  const userRebuilt = planInputOf(GOAL, { ...worldOfPlanUser(planUser), eyeThrows: RECORDED_THROWS.slice(0, 2) }, { readiness: true, journeyReadiness: true, draft: draftOf(seedOf(GOAL, 'overworld')), now: Date.parse('2026-11-27T01:28:25Z') });
  const planBody = (system: unknown, user: string): Json => ({ ...planConfig, system, messages: [{ role: 'user', content: user }] });
  const keyE11 = `plan-e11-${options.group}`;
  bodies[keyE11] = planBody(planSystem, userRebuilt); headers[keyE11] = {};
  // the new world: no eyes, an empty pack, the opening draft, made by this tree
  const { firstPlanInput, openingDraft, seedPlan } = await import('../src/surfaces/minecraft/minecraftFirstPlan.js');
  const fresh = { position: { x: 12.5, y: 70, z: 8.5 }, dimension: 'overworld', biome: 'plains', time: '1000', health: 20, food: 20, inventory: [] };
  const freshUser = firstPlanInput(GOAL, fresh, { readiness: true, journeyReadiness: true, draft: openingDraft(seedPlan(GOAL, 'overworld')), now: Date.parse('2026-11-26T19:17:47Z') });
  const keyE0 = `plan-e0-${options.group}`;
  bodies[keyE0] = planBody(planSystem, freshUser); headers[keyE0] = {};
  const planKeys: Array<[string, string, string]> = [[keyE11, 'e11', B ? 'the recorded first plan (eyes 11, two thrown, the crossing known) built by this tree' : 'the same built by the tree before the fix'],
    [keyE0, 'e0', 'a new world (no eyes) made by this tree']];
  for (let n = 1; n <= options.planReps; n += 1) for (const [key, name, text] of planKeys) {
    cases.push({ name: `${label(`plan-${name}`)}-${n}`, kind: 'plan', group: `${options.group}:plan-${name}`, label: text, key, eyes: name === 'e0' ? null : 11 });
  }
  // the order they are asked in: act d0002/d0044 turn by turn, then the plans, so that a stop at the cap leaves a fair comparison
  const acts = cases.filter(item => item.kind === 'act'), plans = cases.filter(item => item.kind === 'plan');
  const turn = (n: number) => acts.filter(item => item.name.endsWith(`-${n}`));
  const ordered = [...Array.from({ length: options.reps }, (_, index) => turn(index + 1)).flat(), ...plans];
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
      const blocks = (json.content || []).map(b => b.type === 'thinking' ? { type: 'thinking', text: String(b.thinking || '').slice(0, 700) } : b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b.input } : { type: b.type });
      console.log('RESULT ' + JSON.stringify({ name: item.name, status: response.status, stop: json.stop_reason, ms: Date.now() - began, usage, costUsd: cost, spent, blocks,
        transformations: json.input_transformations, error: response.ok ? undefined : (json.error && (json.error.type + ': ' + String(json.error.message).slice(0, 300))) }));
    } catch (error) {
      console.log('RESULT ' + JSON.stringify({ name: item.name, failed: String(error && error.name || error), ms: Date.now() - began, spent }));
    } finally { clearTimeout(timer); }
  }
});
`;

function vmScript(outJson: string, cap: number, only?: string): string {
  const built = JSON.parse(fs.readFileSync(outJson, 'utf8')) as Built;
  const runs = built.cases.filter(item => !only || item.kind === only).map(item => ({ name: item.name, key: item.key }));
  const payload = Buffer.from(JSON.stringify({ cap, runs, bodies: built.bodies, headers: built.headers }), 'utf8').toString('base64');
  return ['#!/usr/bin/env bash', 'set -u', `PAYLOAD='${payload}'`, "read -r -d '' JS <<'JSEOF'", NODE_RUNNER.trim(), 'JSEOF', 'printf \'%s\' "$PAYLOAD" | base64 -d | node -e "$JS"', ''].join('\n');
}

// ---------------------------------------------------------------------------------------------------- score

interface Result { name: string; status?: number; stop?: string; costUsd?: number; blocks?: Json[]; usage?: Json; transformations?: unknown[]; skipped?: string; failed?: string; error?: string; ms?: number }
/** What the answer's first call does about eyes: throws one, mentions a spare / a break / a pearl, turns back from the frontier. */
function extrasOf(blocks: unknown): { throwsEye: boolean; spare: boolean; backtrack: boolean } {
  const call = (Array.isArray(blocks) ? blocks : []).map(record).find(block => block?.type === 'tool_use');
  const input = record(call?.input) ?? {};
  const text = JSON.stringify(input);
  const hands = (Array.isArray(input.hands) ? input.hands : []).map(item => typeof item === 'string' ? item : JSON.stringify(item));
  return { throwsEye: hands.some(item => /ender_eye/u.test(item) && /use|"do":"use"/u.test(item)) || /use item=ender_eye/u.test(text),
    spare: /予備|割れ|余分|もう ?1|あと ?[12] ?個|13/u.test(String(input.why ?? '') + String((Array.isArray(blocks) ? blocks : []).map(record).filter(block => block?.type === 'thinking').map(block => block?.text).join(' '))),
    backtrack: hands.some(item => { const z = /"z":(-?d+)|,(-?d+)(?:s|$)/u.exec(item); const value = z ? Number(z[1] ?? z[2]) : NaN; return /go/u.test(item) && Number.isFinite(value) && value < 1100; }) };
}
/** The counts the plan's nodes carry for rods, pearls and eyes (a doneWhen's 'have:item>=N' or a target's count). */
function countsOf(written: readonly PlanNodeRow[]): { rods: number[]; pearls: number[]; eyes: number[] } {
  const all = JSON.stringify(written);
  const pick = (item: string) => [...all.matchAll(new RegExp(`have:${item}>=(\d+)`, 'gu'))].map(found => Number(found[1]));
  return { rods: pick('blaze_rod'), pearls: pick('ender_pearl'), eyes: pick('ender_eye') };
}
async function score(resultsFile: string, casesFile?: string): Promise<unknown> {
  const cases = casesFile ? (JSON.parse(fs.readFileSync(casesFile, 'utf8')) as Built).cases : [];
  const results = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.startsWith('RESULT ')).map(line => JSON.parse(line.slice(7)) as Result);
  const { strongholdFirst } = await import('../src/surfaces/minecraft/minecraftFirstPlan.js');
  const rows = results.map(result => {
    const kind = result.name.includes('plan-') ? 'plan' : 'act';
    const group = result.name.replace(/-\d+$/u, '');
    if (!result.blocks) return { name: result.name, group, kind, note: result.skipped ?? result.failed ?? result.error ?? 'no answer' };
    const dropped = (result.transformations ?? []).length;
    if (kind === 'act') return { name: result.name, group, kind, ...classifyAct(result.blocks), ...extrasOf(result.blocks), dropped, costUsd: result.costUsd, why: String(record(result.blocks.find(b => b.type === 'tool_use')?.input)?.why ?? '').slice(0, 90) };
    const text = String(result.blocks.find(block => block.type === 'text')?.text ?? '');
    let written: PlanNodeRow[];
    try { written = (JSON.parse(text) as { nodes: PlanNodeRow[] }).nodes; } catch { return { name: result.name, group, kind, note: `unreadable answer (stop ${result.stop ?? '?'})`, costUsd: result.costUsd }; }
    const eyes = group.includes('e0') ? null : 11;
    const kept = ((strongholdFirst({ nodes: written }, eyes) as { nodes: PlanNodeRow[] }).nodes);
    return { name: result.name, group, kind, ...readPlan(written, kept), ...countsOf(written), costUsd: result.costUsd };
  });
  const byGroup = (kind: string) => {
    const groups = [...new Set(rows.filter(row => row.kind === kind).map(row => row.group))];
    return groups.map(group => {
      const mine = rows.filter(row => row.group === group && !('note' in row));
      const summary: Json = { group, n: mine.length, failed: rows.filter(row => row.group === group && 'note' in row).length, costUsd: Number(mine.reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(4)) };
      if (kind === 'act') Object.assign(summary, { verdict: countBy(mine, row => String((row as { verdict?: string }).verdict)), armourWornInInput: cases.find(item => item.group.replace(':', '-') === group)?.armourWorn ?? 'unknown (pass --cases=<built.json>)', klass: countBy(mine, row => String((row as { klass?: string }).klass)), firstTool: countBy(mine, row => String((row as { tool?: string }).tool)),
        firstHand: countBy(mine, row => String((row as { first?: string }).first)), throwsEye: mine.filter(row => (row as { throwsEye?: boolean }).throwsEye).length, spareMention: mine.filter(row => (row as { spare?: boolean }).spare).length, backtrack: mine.filter(row => (row as { backtrack?: boolean }).backtrack).length, droppedThinkingBlocks: mine.reduce((sum, row) => sum + ((row as { dropped?: number }).dropped ?? 0), 0) });
      else Object.assign(summary, { strongholdRaw: mine.map(row => (row as { strongholdRaw?: number | null }).strongholdRaw ?? null), strongholdKept: mine.map(row => (row as { strongholdKept?: number | null }).strongholdKept ?? null),
        portalWrittenKept: `${mine.filter(row => (row as PlanRead).portalWritten).length}/${mine.filter(row => (row as PlanRead).portalKept).length}`,
        obsidianWrittenKept: `${mine.filter(row => (row as PlanRead).obsidianWritten).length}/${mine.filter(row => (row as PlanRead).obsidianKept).length}`,
        atWritten: mine.filter(row => (row as PlanRead).atWritten).length, rods: mine.map(row => (row as { rods?: number[] }).rods), pearls: mine.map(row => (row as { pearls?: number[] }).pearls), eyes: mine.map(row => (row as { eyes?: number[] }).eyes), firstKind: countBy(mine, row => String((row as PlanRead).firstKind)) });
      return summary;
    });
  };
  return { act: byGroup('act'), plan: byGroup('plan'), rows };
}

// ---------------------------------------------------------------------------------------------------- main (not when imported by a test)

async function main(argv: string[]): Promise<void> {
  const [mode, a, b, c] = argv.filter(arg => !arg.startsWith('--'));
  const flag = (name: string) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (mode === 'snapshot' && a && b) {
    const records = openRecords(a);
    fs.writeFileSync(b, JSON.stringify(await treeParts(records, ACT_DECISIONS), null, 1));
    console.log('snapshot written');
  } else if (mode === 'build' && a && b) {
    const group = (flag('group') ?? 'A') as 'A' | 'B';
    const base = flag('base') ? JSON.parse(fs.readFileSync(flag('base')!, 'utf8')) as Json : undefined;
    const tools = flag('tools') ? JSON.parse(fs.readFileSync(flag('tools')!, 'utf8')) as unknown : undefined;
    const out = await build(a, { reps: Number(flag('reps') ?? 6), planReps: Number(flag('plan-reps') ?? 6), group, base, tools });
    fs.writeFileSync(b, JSON.stringify(out, null, 1));
    out.notes.forEach(note => console.log(`NOTE ${note}`));
    console.log(`cases ${out.cases.length}: ${Object.entries(countBy(out.cases, item => item.group)).map(([name, n]) => `${name}×${n}`).join(' ')}`);
  } else if (mode === 'vm-script' && a && b) {
    fs.writeFileSync(b, vmScript(a, Number(c ?? 0.15), flag('only')));
    console.log('script written');
  } else if (mode === 'score' && a) {
    const out = await score(a, flag('cases'));
    if (b) fs.writeFileSync(b, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ act: (out as { act: unknown }).act, plan: (out as { plan: unknown }).plan }, null, 1));
  } else {
    console.error('usage: snapshot <records> <base.json> | build <records> <out.json> [--reps=6 --plan-reps=6 --group=A|B --base=base.json --tools=tools.json] | vm-script <out.json> <script.sh> [capUsd] | score <results.txt> [out.json] [--cases=built.json]');
    process.exit(2);
  }
}
if (process.argv[1] && /minecraft-spare-bench-1127g/u.test(process.argv[1])) await main(process.argv.slice(2));
