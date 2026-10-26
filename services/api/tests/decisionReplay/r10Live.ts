import { answerOf } from './checks.js';
import type { Decision, Entry } from './load.js';
import { posOf, type ActRecord, type Frames } from './preflightFrames.js';
import { stopFacts } from './legacy/minecraftLlmcStopFacts.js';
import { sightLineText, hurtsFromAfar } from './legacy/minecraftLlmcSightLine.js';
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';
import type { ActResult } from '../../src/contracts/minecraftActContract.js';

/**
 * v4（r10 の頭）: 本番の DB に残った判断の入力（履歴と live）に、r10 の頭が足す物を、DB の記録から作れる範囲で足す。
 *
 * 作れる物:
 * - H3 止まりの補足: 止まった・失敗した手の結果に「頭の補足（i do）: …」を足す（本番は結果の本文の最後に足し、履歴にも残る）。
 *   元は、その act の体の結果（fca_body_operations の receipt、手ごとの where・at・map を持つ）と、出した手、フレームの敵（次の判断の live の
 *   threats の行から作る）。履歴のすべての act の結果と、次の判断の live.lastResults に足す。
 * - H5 線上のマス: urgent の「見える」射手（blaze・ghast・skeleton 系・piglin など）の行に、足の場所と敵の場所の直線の上の 1.5m・2.5m 先のマスを足す。
 * 作れない物:
 * - H2 反射の最中の行: 体の r10 の facts.reflexHeld か台帳 state.world.reflexes.recent が要るが、DB の判断の入力にも履歴にも残っていない
 *   （live は body.state・threats・map など。反射の台帳は無い）。H2 は act を送る前の待ちでもあるので、再現台の「1 判断」には効かない。
 * - H3 の afterReflex の欄（体の r10 の欄）。
 * 近似: 敵と自分の場所は live の行の整数（床の座標）なので、線の計算は 0.5 の幅でずれる。敵の canSee は urgent の行の「見える」から。
 */
const MARKER = '（止まった手の周りは、この次の判断の live.lastResults に一度だけ出した）';

/** live の threats の行（「#5 blaze 7.3m (257,61,58)」）と urgent の「見える」から、体のフレームの形を作る。 */
export function observationOf(live: Record<string, any>): BodyObservation | null {
  const body = (live.body ?? {}) as Record<string, any>;
  const at = posOf(body.state?.at);
  if (!at) return null;
  const urgent: string[] = Array.isArray(body.urgent) ? body.urgent : [];
  const sees = (id: string) => urgent.some(line => new RegExp(`#${id} [\\d.]+m・[^]*見える`, 'u').test(line));
  const threats = (Array.isArray(body.threats) ? body.threats as string[] : []).flatMap(line => {
    const m = /^#(\d+) (\S+) ([\d.]+)m \((-?\d+),(-?\d+),(-?\d+)\)/.exec(line);
    return m ? [{ id: Number(m[1]), name: m[2]!, distance: Number(m[3]), position: { x: +m[4]! + 0.5, y: +m[5]!, z: +m[6]! + 0.5 }, canSee: sees(m[1]!) }] : [];
  });
  return { schemaVersion: 1, bodyId: 'minecraft:replay', sequence: 1, stateAt: '', receivedAt: '', connected: true,
    state: { world: { position: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, nearbyThreats: threats } as never }, facts: { alive: true } } as BodyObservation;
}

/** その act（行 j）の止まりの補足の行。無ければ []。 */
function factsOf(decision: Decision, info: Frames, j: number): string[] {
  const record: ActRecord | undefined = info.out.get(j);
  const answer = answerOf((info.ds[j]?.assistant?.content ?? []) as never);
  if (!record || answer.tool !== 'mc.act') return [];
  try {
    const act = JSON.parse(record.resultText) as ActResult;
    const next = info.ds[j + 1] && info.ds[j + 1]!.run === decision.run ? info.ds[j + 1]!.live : info.ds[j]!.live;
    return stopFacts(act, { hands: answer.hands }, observationOf(next));
  } catch { return []; }
}

/** tool_result の本文に補足の行を足す（止まりの周りの印の行があれば、その前に）。 */
function withFacts(content: unknown, facts: string[]): unknown {
  if (!facts.length || typeof content !== 'string') return content;
  const lines = content.split('\n');
  const marker = lines.indexOf(MARKER);
  return (marker >= 0 ? [...lines.slice(0, marker), ...facts, ...lines.slice(marker)] : [...lines, ...facts]).join('\n');
}

function rewriteRow(entries: readonly Entry[], facts: string[]): Entry[] {
  if (!facts.length) return [...entries];
  return entries.map(entry => {
    if (entry.role !== 'user' || !Array.isArray(entry.content)) return entry;
    return { ...entry, content: (entry.content as Array<Record<string, any>>).map(block => block.type === 'tool_result' ? { ...block, content: withFacts(block.content, facts) } : block) };
  });
}

/** urgent の行に線上のマス（H5）を足す: 見える射手・piglin が 3m から 8m に。 */
function urgentWithLines(live: Record<string, any>): { live: Record<string, any>; added: number } {
  const body = (live.body ?? {}) as Record<string, any>;
  if (!Array.isArray(body.urgent)) return { live, added: 0 };
  const observation = observationOf(live);
  let added = 0;
  const urgent = (body.urgent as string[]).map(line => {
    const m = /(?:^|\s)(\S+) #(\d+) ([\d.]+)m・[^]*見える/u.exec(line);
    if (!m || !observation || !hurtsFromAfar(m[1]!.toLowerCase()) || Number(m[3]) > 8 || Number(m[3]) < 3) return line;
    const cell = sightLineText(observation, Number(m[2]), m[1]!.toLowerCase());
    if (!cell) return line;
    added += 1;
    return `${line}。${cell}`;
  });
  return { live: { ...live, body: { ...body, urgent } }, added };
}

export interface R10Input { rows: Entry[][]; turn: Entry[]; notes: { factsRows: number; urgentLines: number; lastResults: boolean } }
/** この判断の入力（epoch の始まりからこの判断の手前までの履歴の行と、この判断の turn）に r10 の頭の足す物を足す。 */
export function r10Input(decision: Decision, info: Frames): R10Input {
  const rows: Entry[][] = [];
  let factsRows = 0;
  for (let j = decision.epochStart; j < decision.index; j += 1) {
    const facts = factsOf(decision, info, j);
    if (facts.length) factsRows += 1;
    rows.push(rewriteRow(decision.run.rows[j]!.entries, facts));
  }
  const previous = decision.index - 1 >= 0 ? factsOf(decision, info, decision.index - 1) : [];
  const { live: withUrgent, added } = urgentWithLines(decision.live);
  let live = withUrgent, lastResults = false;
  const shown = (live.body as Record<string, any> | undefined)?.lastResults;
  if (previous.length && Array.isArray(shown) && typeof shown[0] === 'string' && /^(?:急ぎ: [^\n]*\n)?act /u.test(shown[0])) {
    live = { ...live, body: { ...live.body, lastResults: [`${shown[0]}\n${previous.join('\n')}`, ...shown.slice(1)] } };
    lastResults = true;
  }
  const turn = decision.turn.map(entry => entry.role === 'system' ? { ...entry, content: JSON.stringify(live) } : entry);
  return { rows, turn, notes: { factsRows, urgentLines: added, lastResults } };
}
