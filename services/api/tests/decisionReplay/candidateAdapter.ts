import type { FcaToolDefinition } from '../../src/mind/action/fca/fcaPorts.js';
import type { Decision, Entry } from './load.js';
import type { Frames } from './preflightFrames.js';
import type { Transform } from './headTransform.js';

/**
 * 候補の版（branch codex/shannon/mb-llmc-cand）を台に入れる口。候補の頭は、記録の live から呼べる純粋な関数として、次を作る約束:
 *   live の整形・`around`・`route`・段の知識の選び・短い書き方の戻し・送る前の守り（部分送り・規則の守り）。
 * 台は候補の worktree を土台にした branch で動かす（このファイルの import 先が候補のコードを指すようになる）。できるまでは `loadCandidate` が投げる。
 * 版の表（request.ts の VARIANTS）の `cand` は、この口を通る版（`cand: true`）。見え方（views5.ts の VIEWS）には cand（生の答え）と candt（候補の変換を通した答え）を足す。
 */
export interface CandidateParts {
  /** 要求の固定部分: system（2 ブロック: 輸送の枠 + 指示文）と道具。候補の指示文・道具 6 つ。 */
  fixed(core: readonly FcaToolDefinition[]): Promise<{ system: Array<{ type: 'text'; text: string }>; tools: unknown[] }>;
  /** 判断の後ろに入れる物（段の知識 + live）を、記録の live から作る。履歴（短い要約・手の短い書き方）の作り替えも返せる。 */
  turn(decision: Decision, info: Frames): { turn: Entry[]; rows?: Entry[][]; history?: Entry[] };
  /** 答えを体へ送る前の変換（短い書き方の戻し・stopIf の点検・守り）。守りが止めたら `guard.stopped`、部分送りの手の数が `guard.sentHands`。 */
  transform: Transform;
  /** 守りが止めた時に、聞き直しの要求の後ろへ足すやり取り（止めた手の説明を tool_result で返す）。 */
  reask(decision: Decision, rawInput: unknown, stopText: string, toolUseId: string): Entry[];
}
export async function loadCandidate(): Promise<CandidateParts> {
  throw new Error('DECISION_REPLAY_CANDIDATE_NOT_READY: 候補の頭（mb-llmc-cand）ができたら、このファイルを候補の関数につなぐ');
}
