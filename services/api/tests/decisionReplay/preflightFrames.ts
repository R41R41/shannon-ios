import { answerOf } from './checks.js';
import { decisions, type Run } from './load.js';

/**
 * 守り（minecraftLlmcPreflight.ts）を本番の記録に当てるための部品。
 * 本番の体の結果（fca_body_operations の receipt の result = act の JSON）を、その act を出した判断に結びつけ、
 * 「act を送る時に体が持っていた最新の地図」を見積もる（直前の act の終わりの地図）。判断の live の地図は、次の判断を先に聞く
 * （lookahead）ので、直前の act が終わる前の古い地図のことがある。
 */
export type Pos = { x: number; y: number; z: number };
export const posOf = (text: unknown): Pos | null => { const m = /\((-?\d+),(-?\d+),(-?\d+)\)/.exec(String(text ?? '')); return m ? { x: +m[1]!, y: +m[2]!, z: +m[3]! } : null; };

export interface ActRecord { map: string | undefined; at: Pos | null; resultText: string; startedAt: string; lines: Array<{ i: number; do: string; status: string; line: string }>; stoppedBy?: string }
export function resultsByDecision(run: Run) {
  const ds = decisions(run);
  const acts = run.ops.filter(op => (op.cmd as { skill?: string }).skill === 'act' && op.receipt && typeof (op.receipt as { result?: unknown }).result === 'string');
  const used = new Set<string>();
  const out = new Map<number, ActRecord>();
  for (const decision of ds) {
    const answer = answerOf((decision.assistant?.content ?? []) as never);
    if (answer.tool !== 'mc.act') continue;
    const mine = JSON.stringify(answer.input.hands);
    const op = acts.find(candidate => !used.has(candidate.id) && JSON.stringify(((candidate.cmd as { arguments?: { hands?: unknown } }).arguments ?? {}).hands) === mine);
    if (!op) continue;
    used.add(op.id);
    try {
      const result = JSON.parse((op.receipt as { result: string }).result) as { map?: string; at?: Pos; lines?: ActRecord['lines']; stoppedBy?: string };
      out.set(decision.index, { map: result.map, at: result.at ?? null, resultText: (op.receipt as { result: string }).result, startedAt: op.at, lines: result.lines ?? [], stoppedBy: result.stoppedBy });
    } catch { /* not an act result */ }
  }
  return { ds, out };
}
export type Frames = ReturnType<typeof resultsByDecision>;

/** その判断の act を送る時に体が持っていた最新の地図の見積もり: 直前の act の終わりの地図（無い・合わなければ、判断の live の地図）。 */
export function frameBefore(info: Frames, index: number, live: Record<string, any>): { map: string | undefined; feet: Pos | null; from: 'previous-act' | 'live' } {
  for (let i = index - 1; i >= 0 && i >= index - 3; i -= 1) {
    const result = info.out.get(i);
    if (result?.map && result.at) {
      const head = /足=\((-?\d+),(-?\d+),(-?\d+)\)/.exec(result.map.split('\n')[0] ?? '');
      if (head && +head[1]! === Math.floor(result.at.x) && +head[2]! === Math.floor(result.at.y) && +head[3]! === Math.floor(result.at.z)) {
        return { map: result.map, feet: { x: Math.floor(result.at.x), y: Math.floor(result.at.y), z: Math.floor(result.at.z) }, from: 'previous-act' };
      }
    }
    if (answerOf((info.ds[i]?.assistant?.content ?? []) as never).tool === 'mc.act') break;
  }
  const body = (live.body ?? {}) as Record<string, any>;
  return { map: body.map, feet: posOf(body.state?.at), from: 'live' };
}
