/** The arrows carried into the End: ten crystals and two spare (three sets of four). Closing the bow's node at this number; more is held when it can be (`ARROWS_IF_ABLE`), never asked. */
export const ARROWS_TO_CARRY = 12;
export const ARROWS_IF_ABLE = 16;
/**
 * The owner's decision (11/27): the bow and arrows are made on the way and kept for the fight with the dragon. One sentence for the first plan's words, the shortage's heading and the
 * knowledge, so they cannot drift apart: what they are for, where the short node goes, that none is fired before the fight, that no far trip is made, and why.
 */
export const ARCHERY_ON_THE_WAY = '弓矢（弓＝糸 3＋棒 3、矢は火打石・棒・羽根 各 1 で 4 本）は、竜との戦いでクリスタルを地面から撃つために、要塞へ向かう道中の短い節で作っておく。'
  + '作ったら竜との戦いまで撃たない。村など遠い所へは往復しない。'
  + '理由: 弓矢が無いと柱を積んで登る形になり、足場の材料が尽きて高所で竜に落とされる危険が高い';
/**
 * How the short node closes and stops (the same words in the node's note, the lack line and the knowledge): the made-up share is taken as it is seen, a far search is not made, and a node
 * that is short is closed, not opened again. The reason is the measure: with the mean yields (flint one dig in ten, a chicken's feather about one) all twelve arrows are likelier missing than there.
 */
export const ARCHERY_CLOSING = `矢は ${ARROWS_TO_CARRY} 本（結晶 10＋予備 2）そろえば節を閉じる（持てれば ${ARROWS_IF_ABLE} 本まで持つ）。見えた分だけ作って次へ進み、30m 以内に見えない物は探しに行かない。`
  + '矢が 4〜8 本でも持つ価値はある。そろわなくても節を閉じて要塞へ進んでよい（要塞の前に何度も開き直さない）。'
  + '弓が無く糸も無い時は、羽根・火打石だけを集めに行かない（弓の無い矢は役に立たない。見えた時に拾う程度）。骸骨の弓が荷にあれば糸は要らない。'
  + '理由: 平均の出方（砂利 10 回に 1 個の火打石・ニワトリ 1 羽で羽根約 1）では 12 本がそろわないことの方が多く、探し回るほど要塞が遠のく';
/**
 * Run 9 (11/27): with the first plan putting the stronghold first, the head's 70 hands were all the End's preparation (iron armour, beds, a village): the shortage line read as the list of what
 * to do now, and the stronghold had 0 hands. The words that say where the End's check goes are one sentence here, so the plan's input (`EYES_IN_HAND`, `minecraftFirstPlan.ts`) and the shortage's
 * heading and lack line can say the same thing without two copies drifting apart. It states a place in the order and why; it forbids nothing.
 */
export const END_PREP_AFTER_STRONGHOLD =
  'エンドの点検物（ベッドの 8 個目・黒曜石・足場）は、要塞の後ろでよい。道中・村や溶岩を通る時に取れる分でよく、それを取りに出る節は要らない。'
  + '理由: 先に集めに行った実走は要塞へ 1m も近づかないまま時間が過ぎた。エンドへ入る手の前に足りていればよい。'
  + 'ベッド 1 個のために村へ往復しない。'
  + `弓矢の節は別: ${ARCHERY_ON_THE_WAY}。`
  + '身を守る物の欠け（防具の部位・食料・掘る道具）は別で、要塞へ発つ前に作ってよい（理由: 海を渡り、要塞の中で敵と戦い、エンドで竜と戦うから）。'
  + 'ただし手元の材料か、すぐ近く（目安 30m 以内）で取れる材料で作れる分だけにする。かまどは足元の近くに置いて使い、遠いかまどへ通わない。鉄が足りない時に遠くへ掘りに行く節は作らない。';
