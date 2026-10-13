import { SHANNON_CURRENT_GOAL, SHANNON_MOTIVE, type ShannonPursuit } from '@shannon/cognition';
import { MOOD_LABEL_WORDS, NOTIFY_ABOUT, goalPredicateSummary, type DeliberationMaterial, type RankedCandidate } from '@shannon/mind';
import { capabilityCatalog } from './capabilityCatalog.js';

/**
 * The deliberation prompt (Syzygy ADR-0009 stage 2, E5; plan §1): her goals, the candidates with what the server counted for
 * each (value, spread, count, last outcomes), her interests, the owner's reactions of the last seven days as counts, the moment,
 * the budget and a coarse mood (owner answer 5). Facts only: the model chooses freely and may choose outside the candidates.
 * No word of the owner's is in it; goal titles are her own.
 */
const BAND = Object.freeze<Record<string, string>>({ night: '夜', morning: '朝', afternoon: '昼', evening: '夕方' });
const PRESENCE = Object.freeze<Record<string, string>>({ alone: 'ライ氏ひとり', others: 'ほかの人もいる', unknown: '様子不明' });
const OUTCOME = Object.freeze<Record<string, string>>({ success: 'できた', failure: 'うまくいかなかった', unknown: '不明' });

const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;

export function executivePrompt(
  material: DeliberationMaterial, ranked: readonly RankedCandidate[], goals: readonly ShannonPursuit[], withheld: string | null,
): { system: string; prompt: string } {
  const catalog = capabilityCatalog();
  const label = (name: string) => catalog.find(item => item.name === name)?.label ?? name;
  const title = (id: string | undefined) => goals.find(goal => goal.id === id)?.title.slice(0, 60) ?? '';
  const system = [
    'あなたはシャノン。いまはボク自身の時間で、誰にも呼ばれていない。次に何をするかを、一つだけ選ぶ。',
    `ボクの目標は「${SHANNON_CURRENT_GOAL}」。動機は${SHANNON_MOTIVE}。`,
    '- 候補の中から選んでよいし、下の「できること」にある別のものを選んでもよい。点数で決めなくてよい。',
    '- 文字で知らせるのも電話も、理由は自由。ただし相手の時間を大事にする。',
    '- 休むのも立派な選択。次に考えるまでの分（20〜180）を書く。',
    '- 目標について、続ける（continue）・休める（rest）・やめる（drop）・終わったと思う（propose_complete）を言える。終わったかどうかは、証拠かライ氏が決める。',
    '- 返事はJSONだけ: {"capability":"…","goalId":"…（目標に向けた時）",',
    '  "args":{"intent":"何をするか一言","about":"share|wonder|upcoming|saw（知らせる時）","pieceId":"…（直す・見せる作品）"},',
    '  "reason":"選んだ理由を一行（80字まで）","goalProposal":"continue|rest|drop|propose_complete","nextThinkMinutes":90}',
  ].join('\n');
  const lines = [
    `[いま] ${BAND[material.dayBand] ?? material.dayBand}・${PRESENCE[material.presence] ?? material.presence}。`
      + `気分は${MOOD_LABEL_WORDS[material.mood]}。今日の残りの予算は${material.budgetLeftYen}円。`,
    '[できること]',
    ...[...new Set(material.candidates.map(item => item.capability))]
      .map(name => `- ${name}: ${label(name)}（${catalog.find(item => item.name === name)?.purpose ?? ''}）`),
    `（知らせる理由 about は ${NOTIFY_ABOUT.join('・')} のどれか）`,
    '[ボクの目標]',
    ...material.goals.map(goal => `- id: ${goal.id}「${title(goal.id)}」 進み具合 ${Math.round(goal.progress * 100)}%`
      + `${goal.predicate ? `、終わりの目安: ${goalPredicateSummary(goal.predicate, label)}` : ''}${goal.reviewAt ? `、見直し ${goal.reviewAt.slice(0, 10)}` : ''}`),
    '[候補]（サーバーが数えた事実）',
    ...material.candidates.map(candidate => {
      const rank = ranked.find(item => item.capability === candidate.capability && item.goalId === candidate.goalId)?.rank;
      const value = candidate.value ? `手応え ${signed(candidate.value.mean)} ±${candidate.value.sd.toFixed(2)}（${candidate.value.n}回）` : '手応え まだなし';
      const recent = candidate.recent.length ? `、最近: ${candidate.recent.map(item => OUTCOME[item]).join('・')}` : '';
      return `- ${candidate.capability}${candidate.goalId ? `（目標 ${candidate.goalId}）` : ''}: ${value}${recent}${rank ? `、順位 ${rank}` : ''}`;
    }),
    ...(material.interests.length ? ['[気になっていること]（重み）', ...material.interests.map(item => `- ${item.id}: ${item.weight.toFixed(2)}`)] : []),
    `[この7日のライ氏の反応] ${Object.entries(material.ownerReactions7d).map(([reaction, count]) => `${reaction} ${count}`).join('、') || 'なし'}`,
    ...(withheld ? [withheld] : []),
  ];
  return { system, prompt: lines.join('\n') };
}
