import type { ActHand } from './minecraftActTypes.js';

/** The head chooses the bed, dragon, inventory limit and the retreat; the body synchronizes only this approach's short burst. */
export const BED_BURST_DESCRIPTION = 'bed_burst はエンドで指定したベッド配置を1進入だけ短く起爆する手。'
  + '先に probe kind=bedsite,target=#id で現在の候補を読み、その配置を頭が選んで施工する。未観測の配置では起爆しない。'
  + 'at:[足側,枕側] は同じ高さで水平に隣接する絶対整数座標2つ、target は竜の #id、count はベッド使用上限1〜5、seconds は上限1〜20秒を全部書く。'
  + '現在のphase 2→3、または現在のphase 3だけを扱い、次の着地は待たない。配置選び・足場と支持の施工・材料集めはしない。'
  + '安全な機会なし・着地終了・上限で短く終了し、確認済み爆発数を返す。所有権取消・死亡・世界切替は中断する。'
  + '準備拒否でも頭が選んだ退避goへ進める時はbed_burstにonFail:continueを付け、同じactの後続へ退避goを置く。'
  + '外部abort・生命/世界切替・安全反射はonFailで迂回しない。rel:trueとactのrepeatは使えない。';

export function bedBurstProblem(hand: ActHand): string | null {
  if (hand.rel === true) return 'bed_burst の at は絶対座標（rel:true は使えない）';
  return bedCellsProblem(hand.at) ?? bedBurstTargetProblem(hand.target) ?? bedLimitsProblem(hand);
}

function bedCellsProblem(at: ActHand['at']): string | null {
  if (!Array.isArray(at) || at.length !== 2) return 'at は [足側,枕側] の2マス';
  if (at.some(cell => !cell || ![cell.x, cell.y, cell.z].every(Number.isSafeInteger))) return 'at は絶対整数座標の2マス';
  const [foot, head] = at;
  if (foot!.y !== head!.y || Math.abs(foot!.x - head!.x) + Math.abs(foot!.z - head!.z) !== 1) return 'at の足側と枕側は同じ高さで水平に隣接する2マス';
  return null;
}

export function bedBurstTargetProblem(target: unknown): string | null {
  return typeof target === 'string' && /^#(?:0|[1-9][0-9]*)$/u.test(target) && Number.isSafeInteger(Number(target.slice(1)))
    ? null : 'target は竜の #id（非負の整数）';
}

function bedLimitsProblem(hand: ActHand): string | null {
  if (!Number.isInteger(hand.count) || hand.count! < 1 || hand.count! > 5) return 'count は1〜5の整数';
  if (!Number.isFinite(hand.seconds) || hand.seconds! < 1 || hand.seconds! > 20) return 'seconds は1〜20';
  return null;
}

export function bedBurstActProblem(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const act = input as { hands?: unknown; repeat?: unknown };
  if (!Array.isArray(act.hands)) return null;
  return act.repeat !== undefined && act.hands.some(hand => hand && typeof hand === 'object' && hand.do === 'bed_burst')
    ? 'bed_burst を含む act は repeat を使えない（現在の1進入だけ）' : null;
}
