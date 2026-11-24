/**
 * When she sleeps through a night and when she does not, said once with its reasons and used by every place that tells the head about the night.
 * Before: "at night, sleep" stood in five places with no exception, so she slept while her task was to wait for the night's skeletons, and a sleep booked by
 * day lay down at dusk although the head had moved on to a night's work. The head decides with the `sleep` hand's `on=false` (not tonight) and `on=true`.
 */
/** What a sleep takes away, the reason behind both answers. */
export const SLEEP_COST = '寝れば夜が飛び、朝になる（夜に湧く敵と夜の時間が消える）';
/** The hand that says "not tonight" and the one that takes it back. */
export const SLEEP_SKIP = 'sleep on=false';
export const SLEEP_RESUME = 'sleep on=true';
/** The exception to "sleep at night", for a line that already says the rule. */
export const SLEEP_EXCEPT =
  `ただし${SLEEP_COST}。今の節や依頼が夜そのもの（夜に湧く骸骨・ゾンビ・エンダーマンを倒す・夜のうちに急ぐ）の時と、人が「寝ずに」「寝ないで」と言った時は寝ない: ${SLEEP_SKIP}（今夜は寝ない。理由は act の why に）を先に出す。`
  + 'skip は昼に積んだ寝る予約も体から消す。ファントムが近い（3 夜寝ていない）時や、夜の地上で装備・食料が足りない時で、夜が目的でなければ寝る';
/** The choice, as a clause of a line. */
export const SLEEP_CHOICE = `夜は基本は寝て朝にする（理由: 夜は敵が増え、ファントムも来る）。${SLEEP_EXCEPT}`;
/** What the head's `sleep` hand does with `on`, for the hand's description. */
export const SLEEP_MODES =
  `on=false（今夜は寝ない。体の寝る予約も消す。seconds 60〜300、省くと朝まで。朝・期限・死亡で戻る。夜に湧く敵を倒す・夜に急ぐ・人が寝ないと言った時に先に出す。理由: ${SLEEP_COST}）・on=true（寝ないを解く）`;
