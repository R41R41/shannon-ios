import type { ActHand } from './minecraftActTypes.js';

/** The head chooses the bed, dragon, inventory limit and the retreat; the body synchronizes only this approach's short burst. */
export const BED_BURST_MAX_SECONDS = 60;

/** What the body takes for the booking: how many explosions it may be asked for (default 5), and for how many seconds the booking stands (default 120). The body's own numbers (`utils/bedBurst.ts`). */
export const BED_RESERVE_COUNT_MAX = 10;
export const BED_RESERVE_SECONDS = { least: 10, most: 150 } as const;
export const BED_RESERVE_DEFAULTS = { count: 5, seconds: 120 } as const;

/**
 * The hand that books the bed burst with the body (2026-11-28, run 21: the window to the landing was found at about 5 s left, the head's hand came 11 s later, and the walk to the
 * standing cell met the dragon's neck). The body watches the window and does the walk, the screen, the beds and the leaving by itself; the head only books, and reads what came back.
 * The name and the fields are the body's (`bed_reserve`, 11/28: count 1 to 10, seconds 10 to 150, `on:false` takes the booking back, `on:true` is refused).
 * The act that holds the booking runs for the whole of `seconds` and answers once, at the end: a reflex that takes the body does not end it (the body starts the booking again afterwards).
 */
export const BED_RESERVE_KIND = 'bed_reserve' as const;

export const BED_RESERVE_DESCRIPTION = 'bed_reserve は、エンドで竜をベッドで倒すことを体へ予約する手。座標は書かない。count は使うベッドの数の上限（1〜10、書かなければ 5）、seconds は予約を続ける秒数（10〜150、書かなければ 120）。'
  + '予約するときは on を書かない。予約を取り消す手は {"do":"bed_reserve","on":false} で、そのときは count と seconds を付けない（on:true は断られる）。'
  + '予約すると、体は seconds 秒の間、竜が止まり木へ降りてくる窓（降りてくる途中の残りの時間）を自分で見張る。窓が開いたら、撃つ時に立つマスへ歩く・遮蔽の黒曜石を置く・ベッドを置いて撃つ・元の場所へ戻る、までを続けて行う。間に合わない降りは見送って次の降りを待つ。頭の返事は待たない。'
  + '予約が続いている間、この act は終わらず、結果は最後に 1 回だけ返る（撃ち終えた時、seconds 秒が過ぎた時、竜が倒れた時、取り消された時）。安全のための反射が途中で体を動かしても予約は消えず、反射が終わった後に体が自分で見張りへ戻る。反射が続けて 6 回入った時だけ予約を捨てて頭の判断へ戻す。'
  + '返る文には、撃った回数・見送った理由・竜の体力の減りが入る。'
  + '予約している間は体がこの act に使われている。止めたい時は、この act の命令を取り消す。反射のために体が空いている間なら、{"do":"bed_reserve","on":false} でも取り消せる。予約の act には他の手を足さず、repeat も付けない（反射のあとに体が予約を自分で続けられるのは、手が予約 1 つだけの act の時）。'
  + '理由: 21 回目は、竜が降りるまで残り約 5 秒の窓を見つけてから、頭が撃つ手を返すまでに 11 秒かかった。その手が立つ場所へ歩く途中で、体は降りてきた竜の首に打たれて落ち、死んだ。頭の返事は 4〜11 秒かかるので、数秒で閉じる窓の手は体に任せる。'
  + '使う時: 竜を倒す段に入り、結晶が 0 本で、ベッドを持っている間。予約は 1 回出せばよい。結果が返ったあとで竜が生きていて、まだベッドがあれば、出し直す。'
  + '体が予約を断った時だけ、下の bed_burst（頭が座標を組む旧の手）を使う。';

export const BED_BURST_DESCRIPTION = 'bed_burst は、エンドで頭が指定したベッドの置き場所を、竜の 1 回の降下だけ撃つ手（着地の前から、同じ呼び出しのまま座った竜へも撃ち続ける）。通常は先に bed_reserve（予約）を使い、これは予約が使えない時の旧の手。'
  + '使う時: 竜が止まり木へ降りてくる途中（live の竜の行では phase 2）が見えたら、座るのを待たずにすぐ probe kind=bedsite,target=#id を読む。bedsite は降りてくる途中（phase 2）の間だけ候補を返し、座ってからは current_phase2_required で読めない。'
  + '手順は次の 4 つを 1 つの act に並べる（分けて出すと、降りてくる途中のうちに間に合わない）。(1) go: bedsite が返した stand（撃つ時に立つマス）を to に書く。range は 0.5。(2) place: 返った footing（足場）と screen（遮蔽）の黒曜石のマスを全部置く。supports（支え）が空でも screen は置く。(3) bed_burst。(4) 退避の go。'
  + 'go の range は 0.5 にする。体は、立っている所が stand から 1m 以内でないと撃ち始めず landing_layout_unobserved で断る（range 3 だと 3m 手前で止まって断られた。11/28 の 18 回目）。landing_layout_unobserved は「bedsite を読めていない」ではなく、「stand から 1m より遠い（または別の置き場所）」の意味なので、読み直さず go をやり直す。'
  + 'ベッドを置いて使うのは体で、頭が place するのは黒曜石の足場と壁だけ（ベッドは count 個持っていればよい）。'
  + '待つ場所（止まり木から10〜14m）と起爆に立つ場所（stand）は別（stand は撃つ時に立つマス）。体は stand に着いてから、撃つ前に息の雲・火・竜の頭と首・翼の下・足場を確かめ、危なければ撃たずに断る（断られたら待つ場所へ戻る）。先に probe kind=bedsite,target=#id で今の候補を読み、その置き場所を頭が選んで施工する。読んでいない置き場所では撃たない。'
  + 'at:[足側,枕側] は同じ高さで水平に隣り合う絶対整数座標 2 つ。target は竜の #id。count はベッドを使う上限（1〜5）。seconds は 1〜60 秒の上限（50 を書く。必要なのは、呼んだ後に降りてくる途中の残り、着地後の 7〜10 秒、座ってからの数秒〜最大 27 秒の合計。降りてくる途中は 18 回目の標本で 14〜49秒続き、最短は分かっていない。竜が飛び立てば自分で終わるので、長く書いても余計には待たない）。全部書く。'
  + '呼べるのは、竜が降りてくる途中（phase 2）か着陸中（phase 3）の時だけ（座ってから新しく呼ぶのは断られる）。着陸中でも、同じ降下の phase 2 で bedsite が ready を返していれば呼べる。呼んだ 1 回は着地後も、座った竜（phase 5〜7）へ撃ち続け、座りの被害の合計が 50 を超えて竜が飛び立つ所で終わる。次の着地は待たない。置き場所選び・足場の施工・材料集めはしない。'
  + '撃てる機会が無い・竜が飛び立つ・上限に届く、のどれかで短く終わり、確認できた爆発の数を返す。撃ったのに爆発を 1 回も確かめられなかった時は、成功ではなく失敗の行（止まり）で返り、止まった理由が付く。爆発が見えなかっただけでベッドは使われたかもしれないので、成功とも空振りとも決めつけず、竜の体力と持ち物を見て次を決める。後ろに退避の go を並べていれば、失敗の行のあとも退避は走る。ベッドの持ち主が変わる・死ぬ・ワールドが切り替わると中断する。'
  + '準備を断られても、頭が選んだ退避の go へ進める時は、bed_burst に onFail:continue を付け、同じ act の後ろに退避の go を置く。'
  + '外からの中断・命やワールドの切り替わり・安全の反射は、onFail では迂回できない。rel:true と act の repeat は使えない。';

export function bedReserveProblem(hand: ActHand): string | null {
  if (hand.rel === true) return 'bed_reserve に rel は使えない（座標を持たない手）';
  if (hand.on === false) return hand.count !== undefined || hand.seconds !== undefined ? 'on:false（取り消し）には count と seconds を付けない' : null;
  if (hand.on !== undefined) return 'on は false（取り消し）だけ書く。予約するには on を書かない';
  if (hand.count !== undefined && (!Number.isInteger(hand.count) || hand.count < 1 || hand.count > BED_RESERVE_COUNT_MAX)) return `count は 1〜${BED_RESERVE_COUNT_MAX} の整数（使うベッドの数の上限）`;
  if (hand.seconds !== undefined && (!Number.isFinite(hand.seconds) || hand.seconds < BED_RESERVE_SECONDS.least || hand.seconds > BED_RESERVE_SECONDS.most)) return `seconds は ${BED_RESERVE_SECONDS.least}〜${BED_RESERVE_SECONDS.most}（予約を続ける秒数）`;
  return null;
}

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
  return act.repeat !== undefined && act.hands.some(hand => hand && typeof hand === 'object' && (hand.do === 'bed_burst' || hand.do === BED_RESERVE_KIND))
    ? 'bed_burst と bed_reserve を含む act は repeat を使えない（1 回の降下か 1 回の予約だけ）' : null;
}
