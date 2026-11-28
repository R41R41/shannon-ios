import type { ActHand } from './minecraftActTypes.js';

/** The head chooses the bed, dragon, inventory limit and the retreat; the body synchronizes only this approach's short burst. */
export const BED_BURST_MAX_SECONDS = 60;

export const BED_BURST_DESCRIPTION = 'bed_burst はエンドで指定したベッド配置を1進入だけ起爆する手（着地前から、同じ呼び出しのまま座った竜へも撃ち続ける）。'
  + '使う時: 竜が止まり木へ降りてくる途中（phase 2）が見えたら、座るのを待たずにすぐ probe kind=bedsite,target=#id を読む。bedsite は phase 2 の間だけ候補を返し、座ってからは current_phase2_required で読めない。'
  + '手順は1つの act に go（返った stand を to に、range は 0.5）→ place（返った footing と screen の黒曜石のマスを全部。supports が空でも screen は置く）→ bed_burst → 退避go（分けて出すと phase 2 の間に間に合わない）。go の range は 0.5: 体は立っている所が bedsite の stand から 1m 以内でないと起爆を始めず landing_layout_unobserved で断る（range 3 だと 3m 手前で止まって断られた。11/28 の 18 回目）。landing_layout_unobserved は「bedsite を読めていない」ではなく、stand から 1m を超えている（または別の配置）の意味なので、読み直さず go をやり直す。ベッドを置いて使うのは体で、頭が place するのは黒曜石の足場と壁だけ（ベッドは count 個持っていればよい）。'
  + '先に probe kind=bedsite,target=#id で現在の候補を読み、その配置を頭が選んで施工する。未観測の配置では起爆しない。'
  + 'at:[足側,枕側] は同じ高さで水平に隣接する絶対整数座標2つ、target は竜の #id、count はベッド使用上限1〜5、seconds は上限1〜60秒（50を書く。呼び出しから phase 2 の飛行13〜21秒＋着地7〜10秒＋座ってからの数秒〜最大27秒が要る。竜が飛び立てば自分で終わるので、長く書いても余計に待たない）を全部書く。'
  + '呼べるのは現在のphase 2か3のときだけ（座ってから新しく呼ぶのは断られる）。phase 3（着陸中）でも、同じ進入の phase 2 で bedsite が ready を返していれば呼べる（phase 3 になってから bedsite は新しく読めない）。呼んだ1回は着地後も、座った竜（phase 5〜7）へ撃ち続け、座りの被害の累積が50を超えて竜が飛び立つ所で終わる。次の着地は待たない。配置選び・足場と支持の施工・材料集めはしない。'
  + '安全な機会なし・竜の飛び立ち・上限で短く終了し、確認済み爆発数を返す。所有権取消・死亡・世界切替は中断する。'
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
  if (!Number.isFinite(hand.seconds) || hand.seconds! < 1 || hand.seconds! > BED_BURST_MAX_SECONDS) return `seconds は1〜${BED_BURST_MAX_SECONDS}`;
  return null;
}

export function bedBurstActProblem(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const act = input as { hands?: unknown; repeat?: unknown };
  if (!Array.isArray(act.hands)) return null;
  return act.repeat !== undefined && act.hands.some(hand => hand && typeof hand === 'object' && hand.do === 'bed_burst')
    ? 'bed_burst を含む act は repeat を使えない（現在の1進入だけ）' : null;
}
