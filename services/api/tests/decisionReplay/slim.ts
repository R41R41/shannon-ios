import { ACT_DESCRIPTION } from '../../src/contracts/minecraftActContract.js';
import { llmcCoreKnowledge } from '../../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { answerOf } from './checks.js';
import type { Decision, Entry } from './load.js';
import type { Frames } from './preflightFrames.js';
import { actToShort, shortToAct } from './shortHands.js';

/**
 * v8（絞った形、10/23）: 作りを増やさず、Opus 1 本のまま、その判断に必要な情報だけを渡し、出力を小さくする。4 つの絞りを 1 つずつ足せる。
 * - tools: 道具を基本の 6 つ（mc.act・mc.probe・mc.view・plan.update・fca_wait・fca_complete）だけにして先頭に固定。
 * - knowledge: 指示文の知識を「いつも要る段」と「場面で選ぶ段」に分け、場面の計画の今の節・次元・持ち物からコードで選んだ段だけを、
 *   キャッシュの印より後ろ（live の前）に入れる。
 * - history: epoch の履歴を、短い要約（試した手・結果・同じやり直しの禁止、コードが作る）と直近 3 回のやり取りだけにする。
 * - short: 手を短い書き方にする（shortHands.ts）。履歴の過去の act も同じ書き方に直して見せる。
 */
export interface Slim { tools?: boolean; knowledge?: boolean; history?: boolean; short?: boolean }

/* ------------------------------------------------------------------ 道具 */
export const SLIM_TOOL_NAMES = ['mc_act', 'mc_probe', 'mc_view', 'plan_update', 'fca_wait', 'fca_complete'];
export function slimTools(tools: Array<{ name: string }>): Array<{ name: string }> {
  return SLIM_TOOL_NAMES.flatMap(name => tools.filter(tool => tool.name === name));
}

/* ------------------------------------------------------------------ 知識の段 */
export type StageId = 'prep' | 'nether' | 'end';
const STAGE_TITLES: Record<StageId, string> = { prep: '## 材料と手順', nether: '## ネザー・要塞・ブレイズ', end: '## パール・アイ・エンド' };
export interface KnowledgeSplit { always: string; stages: Record<StageId, string> }
export function splitKnowledge(): KnowledgeSplit {
  const sections = llmcCoreKnowledge(true).split(/\n\n(?=## )/u);
  const stages = {} as Record<StageId, string>;
  const always: string[] = [];
  for (const section of sections) {
    const id = (Object.keys(STAGE_TITLES) as StageId[]).find(key => section.startsWith(STAGE_TITLES[key]));
    if (id) stages[id] = section; else always.push(section);
  }
  return { always: always.join('\n\n'), stages };
}
/** この場面（live の計画の今の節・次元・持ち物）で要る段。いずれにも当たらなければ、次元の段。 */
export function stagesFor(live: Record<string, any>): StageId[] {
  const body = (live.body ?? {}) as Record<string, any>;
  const dimension = String(body.state?.dimension ?? ''), inside = String(body.state?.inside ?? '');
  const node = `${String(body.planNow ?? '')} ${String((live.plan?.next ?? [])[0] ?? '')}`;
  const inventory = (Array.isArray(body.inventory) ? body.inventory as string[] : []).join(' ');
  const found = new Set<StageId>();
  if (/作業台|ハーフブロック|盾|食料|鉄|ダイヤ|黒曜石|ゲート|ベッド|村|原木|木|かまど|ツルハシ|金/u.test(node) || dimension === 'overworld') found.add('prep');
  if (dimension === 'the_nether' || /ネザー|要塞|ブレイズ|ポータル|ロッド|棒|ピグリン/u.test(node) || /要塞|砦/u.test(inside)) found.add('nether');
  if (dimension === 'the_end' || /パール|アイ|エンド|ストロング|ドラゴン|エンダー/u.test(node) || /ender_(pearl|eye)/u.test(inventory)) found.add('end');
  if (!found.size) found.add(dimension === 'the_nether' ? 'nether' : 'prep');
  // ネザーの中で材料の節（板・作業台など）を作る時は prep も要る: 次元が ネザー でも節が材料なら prep。
  return (['prep', 'nether', 'end'] as StageId[]).filter(id => found.has(id));
}
/** 場面の知識の system entry（live と同じく次のユーザー発話で消える）。 */
export function knowledgeEntry(live: Record<string, any>, split: KnowledgeSplit, template: Entry): Entry {
  const ids = stagesFor(live);
  return { ...template, content: `（この場面の知識: ${ids.join('・')}）\n${ids.map(id => split.stages[id]).join('\n\n')}` };
}

/* ------------------------------------------------------------------ 履歴 */
const clip = (text: string, n: number) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const cellOf = (hand: { to?: { x: number; y: number; z: number }; at?: Array<{ x: number; y: number; z: number }>; path?: Array<{ x: number; y: number; z: number }> }) =>
  hand.to ?? hand.path?.at(-1) ?? hand.at?.[0];
/** epoch の rows[from, to) を、試した手・結果・同じやり直しの禁止の短い文にする（コードが作る。要約器は使わない）。 */
export function summaryOf(decision: Decision, from: number, to: number, maxChars = 4200): string {
  const lines: string[] = [];
  const stops = new Map<string, number>();
  for (let j = from; j < to; j += 1) {
    const row = decision.run.rows[j]!;
    const assistant = row.entries.find(entry => entry.role === 'assistant');
    const blocks = (assistant && Array.isArray(assistant.content) ? assistant.content : []) as Array<Record<string, any>>;
    const use = blocks.find(block => block.type === 'tool_use');
    const result = row.entries.flatMap(entry => entry.role === 'user' && Array.isArray(entry.content) ? entry.content as Array<Record<string, any>> : [])
      .find(block => block.type === 'tool_result');
    const text = typeof result?.content === 'string' ? result.content : '';
    if (!use) continue;
    if (use.name === 'mc_act') {
      const answer = answerOf(blocks);
      const hands = actToShort(answer.input).hands.slice(0, 4).map(line => clip(line, 70)).join(' ; ');
      const stopLine = text.split('\n').find(line => /^\d+ \w+ (止|失) /u.test(line));
      const head = text.split('\n')[0] ?? '';
      lines.push(`- act ${clip(answer.hands.map(hand => hand.do).join('→'), 40)}: ${hands}${answer.hands.length > 4 ? ' …' : ''} ⇒ ${stopLine ? clip(stopLine, 110) : clip(head, 60)}`);
      if (stopLine) {
        const m = /^(\d+) (\w+) (?:止|失) ([^:：\s]+)/u.exec(stopLine);
        const hand = m ? answer.hands[Number(m[1]) - 1] : undefined;
        const cell = hand ? cellOf(hand as never) : undefined;
        if (m && cell) stops.set(`${m[2]} ${cell.x},${cell.y},${cell.z} ${m[3]}`, (stops.get(`${m[2]} ${cell.x},${cell.y},${cell.z} ${m[3]}`) ?? 0) + 1);
      }
    } else lines.push(`- ${String(use.name)} ${clip(JSON.stringify(use.input), 60)} ⇒ ${clip((text.split('\n')[0] ?? ''), 70)}`);
  }
  const bans = [...stops].filter(([, n]) => n >= 2).map(([key, n]) => `${key}（${n} 回）`);
  let body = lines.join('\n');
  while (body.length > maxChars && lines.length > 3) { lines.shift(); body = lines.join('\n'); }
  return ['（これまでの試しの要約。コードが作った。細かい座標は live の plan と map を見る）', body,
    ...(bans.length ? [`同じやり直しをしない（2 回以上止まった手）: ${bans.slice(-8).join('、')}`] : [])].join('\n');
}

/**
 * 圧縮した履歴: epoch の最初の状態（goal など）+ 要約 + 直近のやり取り。要約は `block` 判断ごとにだけ作り直す（毎判断作り直すと、履歴の先頭が毎回変わって
 * キャッシュが効かない）ので、直近のやり取りは keep〜keep+block-1 回。
 */
export function compactHistory(decision: Decision, keep = 3, block = 6, rowsOverride?: Entry[][]): Entry[] {
  const rows = decision.run.rows;
  const start = decision.epochStart;
  const windowStart = start + block * Math.floor(Math.max(0, decision.index - start - keep) / block);
  const entries = rowsOverride ? rowsOverride.slice(windowStart - start).flat() : rows.slice(windowStart, decision.index).flatMap(row => row.entries);
  if (windowStart === start) return entries;
  const state = rows[start]!.entries[0]!;
  const summary = { type: 'text', text: summaryOf(decision, start, windowStart) };
  const blocks = Array.isArray(state.content) ? [...(state.content as unknown[]), summary] : [{ type: 'text', text: String(state.content) }, summary];
  return [{ ...state, content: blocks }, ...entries.filter((entry, index) => !(index === 0 && entry === state))];
}

/* ------------------------------------------------------------------ 短い書き方の道具と履歴 */
export const SHORT_GRAMMAR = [
  'hands は手の文字列の配列（1 手 1 文字列。座標は x,y,z の整数。複数の座標・点は空白で続ける）:',
  'walk X,Y,Z（点を空白で続けると path）[sprint] [range=N]: 掘らない・置かない・段差1と泳ぎだけ。地図の外の遠い点は64mごとに区切って歩き、掘る所で止まる / '
    + 'dig X,Y,Z ...（順に掘る）[tool=名] [exposeOk] [takeOk] [collect=false] / place ブロック名 X,Y,Z ... [face=down] / pillarUp N [ブロック名]（真下に置きながら N 段登る） / '
    + 'use 物 X,Y,Z [face=..]（バケツ・火打ち金・ベッド・扉・エンダーアイ） / look X,Y,Z か look yaw=A pitch=B / jump N / sneak on|off / equip 物 [slot] / craft 物 [個数] / eat 物 / '
    + 'attack 相手(#id か名前) [hold] seconds=N [untilDead=false] / pickup [range=N] [target=..] / wait 秒。',
  'どの手にも rel（足のブロックからの差）と onFail=continue|stop を付けられる。furnace・chest・drop・shoot など上に無い形は json {手の JSON} の 1 行。',
  'stopIf は "hostileWithin=8 hpBelow=10" の形の文字列、accept は戦うと決めた敵の種類の配列、why は act に 1 つ。',
].join('\n');
export function shortActTool(): Record<string, unknown> {
  const lines = ACT_DESCRIPTION.split('\n');
  const kept = lines.filter(line => !line.startsWith('手（do）と引数') && !line.startsWith('座標はブロックの整数') && !line.startsWith('形: why は act に 1 つ'));
  return {
    name: 'mc_act', description: [kept[0], kept[1], SHORT_GRAMMAR, ...kept.slice(2)].join('\n'),
    input_schema: { type: 'object', additionalProperties: false, required: ['hands'], properties: {
      why: { type: 'string', maxLength: 120, description: 'この手の組のねらい（短く）' },
      hands: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 400 }, description: '順に動かす手（1〜12、1 手 1 文字列）' },
      stopIf: { type: 'string', maxLength: 80 }, accept: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } } } },
  };
}
/** 履歴の過去の act（assistant の tool_use mc_act）を短い書き方に直す。 */
export function shortenEntries(entries: readonly Entry[]): Entry[] {
  return entries.map(entry => {
    if (entry.role !== 'assistant' || !Array.isArray(entry.content)) return entry;
    return { ...entry, content: (entry.content as Array<Record<string, any>>).map(block => block.type === 'tool_use' && block.name === 'mc_act' && Array.isArray(block.input?.hands)
      ? { ...block, input: actToShort(block.input) } : block) };
  });
}
/** モデルの短い書き方の答えを今の JSON の act に直す（読めない行があれば、体に送れない欄を付けて ×）。 */
export function expandAnswer(content: Array<Record<string, any>>): Array<Record<string, any>> {
  return content.map(block => {
    if (block.type !== 'tool_use' || block.name !== 'mc_act') return block;
    const { act, errors } = shortToAct(block.input);
    return { ...block, input: errors.length ? { ...act, 書き方の誤り: errors.join(' / ').slice(0, 200) } : act };
  });
}
export type { Frames };
