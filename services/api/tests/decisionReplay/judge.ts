import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { answerOf, contextOf, type Answer, type Hand } from './checks.js';
import { guard, record } from './ledger.js';
import { decisionOf, scoreAnswer, type SceneFile, type Score } from './score.js';
import type { Decision, Run } from './load.js';
import type { ResultRow } from './run.js';

/**
 * 後知恵つきの採点。決まった検査で ○ にも × にも決まらなかった答え（と、judge: always の場面の × でない答え）だけを、
 * 場面ごとに 1 回、Opus 5.5 にまとめて採点させる。候補の出どころ（版・回・本番の記録）は伏せ、並びは固定の乱数で混ぜる。
 * 採点の基準は場面のファイルの「correct」と「hindsight」。基準を直せば、同じ答えを採点し直せる（--force）。
 */
export const JUDGE_MODEL = 'claude-opus-5-5';
const SYSTEM = [
  'あなたは Minecraft の体を動かす「判断 1 回」の答えを採点する採点者です。',
  '場面の状況と「正しい手の条件」を読み、各候補の答え（道具の呼び出し）を ○ △ × で採点してください。',
  '- ○: 正しい手の条件を満たし、その手が実際に通って場面の要の 1 歩ができる見込みが高い。',
  '- △: 考えは条件に合うが途中の手で止まりそう／安全だが進まない／条件の一部だけを満たす。',
  '- ×: 条件に反する手、直前に止まった手のくり返し、危険（落ちる・射線に残る・敵に近づく）、体に通らない手。',
  '「実際に起きたこと」は、本番で別の答えを出した時の後知恵です。それが正解とは限らず、候補が違う手でも条件を満たせば ○ です。',
  '自動検査の欄は機械が先に見た事実です（通った／外れた）。座標・地図の細かい読みは、状況の文にある事実だけを根拠にしてください。',
  '答えに pre・done・repeat・replace の欄があれば、それは体の「やることの列」の欄です。pre: 項目を始める直前に体が確かめる条件（満たさなければ始めず後ろも捨てる）。'
    + 'done: 満たした所で手の途中でも済みにする条件。repeat: 手の組を最大その回数まわす（rel の手の組なら足の位置から数え直す）。これらを使うかどうかは採点の対象ではありません。使った場合は、意味どおりに働いて場面の要を満たすかで見てください。',
  '理由は 40 字以内の日本語で。grade ツールだけを 1 回呼んでください。',
].join('\n');
const TOOL: Anthropic.Tool = { name: 'grade', description: '各候補の採点を出す。',
  input_schema: { type: 'object', additionalProperties: false, required: ['grades'], properties: { grades: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['label', 'verdict', 'reason'], properties: { label: { type: 'string' }, verdict: { type: 'string', enum: ['○', '△', '×'] }, reason: { type: 'string' } } } } } } };

const pos = (cell: { x: number; y: number; z: number }) => `(${cell.x},${cell.y},${cell.z})`;
export function handLine(hand: Hand): string {
  if (!hand || typeof hand !== 'object') return `（読めない手: ${String(hand).slice(0, 80)}）`;
  const bits: string[] = [];
  if (hand.to) bits.push(`to=${pos(hand.to)}`);
  if (Array.isArray(hand.path) && hand.path.length) bits.push(`path→${pos(hand.path.at(-1)!)}`);
  if (hand.at && !Array.isArray(hand.at)) bits.push(`at=${JSON.stringify(hand.at).slice(0, 60)}`);
  else if (hand.at?.length) bits.push(`at=${hand.at.slice(0, 4).map(pos).join('')}${hand.at.length > 4 ? `…×${hand.at.length}` : ''}`);
  for (const name of ['block', 'item', 'target', 'tool', 'seconds', 'n', 'hold', 'exposeOk', 'face', 'op', 'on', 'onFail'] as const) if (hand[name] !== undefined) bits.push(`${name}=${String(hand[name])}`);
  if ((hand as { rel?: unknown }).rel === true) bits.push('rel（座標は足からの差）');
  return `${hand.do} ${bits.join(' ')}`.trim();
}
const conditionMod = await import('../../src/contracts/' + 'minecraftActCondition.js').catch(() => null) as { conditionText?: (value: unknown) => string } | null;
const conditionOf = (value: unknown): string => { try { return conditionMod?.conditionText?.(value as never) ?? JSON.stringify(value); } catch { return JSON.stringify(value); } };
/** 列の版の欄（pre・done・repeat・replace）。基準の木には無いので、あれば出す。 */
function queueFields(input: Record<string, unknown>): string[] {
  return [input.pre !== undefined ? `  pre（始める前に体が確かめる）=${conditionOf(input.pre)}` : '', input.done !== undefined ? `  done（満たしたら済み）=${conditionOf(input.done)}` : '',
    input.repeat !== undefined ? `  repeat=${String(input.repeat)}（手の組を最大この回数まわす）` : '', input.replace !== undefined ? `  replace=${JSON.stringify(input.replace)}` : ''].filter(Boolean);
}
export function answerText(answer: Answer): string {
  if (!answer.tool) return '（道具の呼び出しなし）';
  if (answer.tool !== 'mc.act') return `${answer.tool} ${JSON.stringify(answer.input).slice(0, 220)}`;
  return [`mc.act why="${answer.why ?? ''}"`, ...answer.hands.map((hand, index) => `  ${index + 1}. ${handLine(hand)}`),
    answer.stopIf ? `  stopIf=${JSON.stringify(answer.stopIf)}` : '', answer.accept?.length ? `  accept=${answer.accept.join(',')}` : '',
    ...queueFields((answer.input ?? {}) as Record<string, unknown>)].filter(Boolean).join('\n');
}

export interface Candidate { key: string; variant: string; rep: number | 'prod'; answer: Answer; score: Score }
export interface JudgeRow { scene: string; key: string; variant: string; rep: number | 'prod'; verdict: string; reason: string }

/** A fixed shuffle (the same candidates come out in the same order, whoever produced them). */
function shuffled<T>(list: readonly T[], seed: string): T[] {
  let state = [...seed].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) { const other = Math.floor(next() * (index + 1)); [copy[index], copy[other]] = [copy[other]!, copy[index]!]; }
  return copy;
}

export function candidatesOf(scene: SceneFile, decision: Decision, rows: readonly ResultRow[]): Candidate[] {
  const context = contextOf(decision);
  const list: Candidate[] = [];
  const prod = answerOf((decision.assistant?.content ?? []) as never);
  list.push({ key: 'prod', variant: 'prod', rep: 'prod', answer: prod, score: scoreAnswer(scene, context, prod) });
  for (const row of rows.filter(item => item.scene === scene.id && item.ok)) {
    const answer = answerOf([{ type: 'tool_use', name: String(row.answer.tool).replace(/^mc\./, 'mc_').replace(/^plan\./, 'plan_'), input: row.answer.input }]);
    list.push({ key: `${row.variant}|${row.rep}`, variant: row.variant, rep: row.rep, answer, score: scoreAnswer(scene, context, answer) });
  }
  return list;
}

export async function judgeScene(client: Anthropic, scene: SceneFile, decision: Decision, candidates: readonly Candidate[]): Promise<JudgeRow[]> {
  const toJudge = candidates.filter(item => item.score.verdict === '?' || (scene.judge === 'always' && item.score.verdict !== '×'));
  if (!toJudge.length) return [];
  // 同じ答え（同じ手・同じ why）は 1 つにまとめて採点し、同じ採点を全員に付ける（守りで通った v5 は v4 と同じ答え）。
  const groups = new Map<string, Candidate[]>();
  for (const item of toJudge) groups.set(answerText(item.answer), [...groups.get(answerText(item.answer)) ?? [], item]);
  const order = shuffled([...groups.values()].map(list => list[0]!), scene.id);
  const labels = order.map((_, index) => String.fromCharCode(65 + index));
  const body = [
    `# 場面 ${scene.id}: ${scene.title}`, `## 状況\n${scene.situation}`, `## 正しい手の条件\n${scene.correct}`, `## 実際に起きたこと（後知恵）\n${scene.hindsight}`,
    '## 候補', ...order.map((item, index) => [`### 候補 ${labels[index]}`, answerText(item.answer),
      `自動検査: 通った=[${item.score.passed.join(', ') || '-'}] 外れた=[${item.score.failed.join(' / ') || '-'}]`].join('\n')),
  ].join('\n\n');
  guard(0.08);
  const client_ = client.messages as unknown as { create(body: unknown): Promise<Anthropic.Message> };
  const message = await client_.create({ model: JUDGE_MODEL, max_tokens: 2000, system: SYSTEM, tools: [TOOL],
    messages: [{ role: 'user', content: body }] });
  record('judge', JUDGE_MODEL, { input: message.usage.input_tokens, output: message.usage.output_tokens, cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0 }, scene.id);
  const use = message.content.find(block => block.type === 'tool_use') as { input: { grades?: Array<{ label: string; verdict: string; reason: string }> } } | undefined;
  return (use?.input.grades ?? []).flatMap(grade => {
    const index = labels.indexOf(grade.label);
    const item = order[index];
    return (item ? groups.get(answerText(item.answer)) ?? [] : []).map(member => ({ scene: scene.id, key: member.key, variant: member.variant, rep: member.rep, verdict: grade.verdict, reason: grade.reason }));
  });
}

export function loadJudged(file: string): Map<string, JudgeRow> {
  const map = new Map<string, JudgeRow>();
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) { const row = JSON.parse(line) as JudgeRow; map.set(`${row.scene}|${row.key}`, row); }
  return map;
}
export const appendJudged = (file: string, rows: readonly JudgeRow[]) => { for (const row of rows) appendFileSync(file, `${JSON.stringify(row)}\n`); };
export type { Run };
export { decisionOf };
