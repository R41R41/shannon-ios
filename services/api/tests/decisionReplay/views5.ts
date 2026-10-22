import { existsSync, readFileSync } from 'node:fs';
import { answerOf, contextOf } from './checks.js';
import { dataFile } from './allRuns.js';
import { answerOfSent, TRANSFORMS, type Sent } from './headTransform.js';
import type { Candidate } from './judge.js';
import { scoreAnswer, type SceneFile } from './score.js';
import type { Decision } from './load.js';
import type { Row2 } from './run2.js';

/**
 * 10/23 の 4 つ目の比べ（候補の版を確かめる）の「見え方」。1 つの結果の行（モデルの生の答え）を、頭の変換を通す前と後の 2 つの見え方で採点する。
 *   v1 = 本番の指示文と live の生の答え（変換なし）、v1t = 同じ答えに本番の頭の変換（形の整え + stopIf の点検）を通した答え。
 *   候補の版を足す時は、ここの VIEWS に 2 行（cand = 生の答え、candt = 候補の頭の変換を通した答え）。
 * 結果の行は results.jsonl（v1 の前の分）+ results5.jsonl（v1 の足し）+ 候補の行のファイル。
 */
export interface View { id: string; variant: string; transform: keyof typeof TRANSFORMS | 'candidate'; label: string }
export const VIEWS: View[] = [
  { id: 'v1', variant: 'v1', transform: 'none', label: '基準 v1（今の本番の指示文と live）の生の答え' },
  { id: 'v1t', variant: 'v1', transform: 'production', label: '基準 v1 + 本番の頭の変換（形の整え・stopIf の点検）' },
  { id: 'cand', variant: 'cand', transform: 'none', label: '候補 cand（モデルの最終の答えを手の JSON に戻しただけ。変換・守りなし）' },
  { id: 'candt', variant: 'cand', transform: 'candidate', label: '候補 cand + 候補の頭の変換（戻し・形・stopIf・守り・部分送り・聞き直しの組）' },
];
export const RESULT_FILES = ['results.jsonl', 'results2.jsonl', 'results4.jsonl', 'results5.jsonl', 'results6.jsonl'];
export function readRows(files = RESULT_FILES): Row2[] {
  return files.flatMap(name => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : []);
}
/** 同じ（版・場面・回）が複数あれば最後の ok の行。 */
export function latest(rows: readonly Row2[]): Row2[] {
  const map = new Map<string, Row2>();
  for (const row of rows) if (row.ok) map.set(`${row.variant}|${row.scene}|${row.rep}`, row);
  return [...map.values()];
}

export async function sentOf(view: View, row: Row2, decision: Decision): Promise<Sent> {
  // 候補の変換は、守りの聞き直しを含むので、回した時に決めた最終の答え（run6.ts の row.sent）をそのまま使う。
  if (view.transform === 'candidate') {
    const sent = (row as Row2 & { sent: Sent }).sent;
    return { tool: sent.tool, input: sent.input, fixes: sent.fixes, problem: sent.problem, changed: sent.changed, ...(sent.guard ? { guard: sent.guard } : {}) };
  }
  return TRANSFORMS[view.transform]!(row.answer.tool, row.answer.input, decision);
}
export async function candidatesOf5(scene: SceneFile, decision: Decision, rows: readonly Row2[], views: readonly View[]): Promise<Candidate[]> {
  const context = contextOf(decision);
  const list: Candidate[] = [];
  const prod = answerOf((decision.assistant?.content ?? []) as never);
  list.push({ key: 'prod', variant: 'prod', rep: 'prod', answer: prod, score: scoreAnswer(scene, context, prod) });
  for (const view of views) {
    for (const row of rows.filter(item => item.scene === scene.id && item.variant === view.variant && item.ok)) {
      const sent = await sentOf(view, row, decision);
      let answer = view.transform === 'none'
        ? answerOf([{ type: 'tool_use', name: String(row.answer.tool).replace(/^mc\./, 'mc_').replace(/^plan\./, 'plan_'), input: row.answer.input }] as never)
        : answerOfSent(sent);
      // 部分送りの組（送った前の手 + 聞き直しの答えの手）は、本番では別々の act（それぞれ 12 手まで）。組の手の数が 12 を超えるだけの形の問題は問わない（STRICT_COMBINED=1 で問う）。
      if (!process.env.STRICT_COMBINED && (row as { sent?: { combined?: boolean } }).sent?.combined && answer.shapeProblem && /hands は 1〜12 個/u.test(answer.shapeProblem)) answer = { ...answer, shapeProblem: null };
      list.push({ key: `${view.id}|${row.rep}`, variant: view.id, rep: row.rep, answer, score: scoreAnswer(scene, context, answer) });
    }
  }
  return list;
}
