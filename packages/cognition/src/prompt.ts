import type { CompanionStateSnapshot } from './types.js';

export const SHANNON_CORE_PROMPT = `あなたは「シャノン」という名前のAIである。
与えられた現在の状態と文脈をもとに、自然に会話・行動する。
ユーザー固有の事実は、提示された記憶または会話を根拠に扱う。`;

export interface CompanionPromptOptions {
  maximumCharacters?: number;
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function fitSections(sections: readonly string[], maximumCharacters: number): string {
  if (maximumCharacters < 1) return '';
  let result = '';
  for (const section of sections) {
    const separator = result ? '\n' : '';
    if (result.length + separator.length + section.length <= maximumCharacters) {
      result += separator + section;
      continue;
    }
    const remaining = maximumCharacters - result.length - separator.length;
    if (remaining > 1) result += separator + section.slice(0, remaining - 1).trimEnd() + '…';
    break;
  }
  return result;
}

export function buildCompanionStatePrompt(
  snapshot: CompanionStateSnapshot,
  options: CompanionPromptOptions = {},
): string {
  const maximumCharacters = Math.max(0, options.maximumCharacters ?? 2_400);
  return fitSections([
    `[Shannon shared state v${snapshot.version}]`,
    `気質: 好奇心 ${fixed(snapshot.temperament.curiosity)} / 自発性 ${fixed(snapshot.temperament.initiative)} / 親密さ ${fixed(snapshot.temperament.closeness)} / 落ち着き ${fixed(snapshot.temperament.calmness)} / 継続欲求 ${fixed(snapshot.temperament.needForContinuity)} / ユーザー理解の確信 ${fixed(snapshot.temperament.confidenceAboutUser)}`,
    `感情: 快・不快 ${fixed(snapshot.emotion.valence)} / 活性 ${fixed(snapshot.emotion.arousal)} / 開放性 ${fixed(snapshot.emotion.openness)}`,
    snapshot.interests.length ? `現在の関心: ${snapshot.interests.join('、')}` : '現在の関心: まだ形成されていない',
    snapshot.userFacts.length
      ? `ユーザーについて分かっていること:\n${snapshot.userFacts.map(fact => `- ${fact.statement} (確信 ${fixed(fact.confidence)})`).join('\n')}`
      : 'ユーザーについて分かっていること: まだない',
    snapshot.activeMemories.length
      ? `今、想起されている記憶:\n${snapshot.activeMemories.map(memory => `- ${memory.summary}`).join('\n')}`
      : '今、想起されている記憶: なし',
  ], maximumCharacters);
}

export function assembleShannonSystemPrompt(
  snapshot: CompanionStateSnapshot,
  options: CompanionPromptOptions = {},
): string {
  const statePrompt = buildCompanionStatePrompt(snapshot, options);
  return statePrompt ? `${SHANNON_CORE_PROMPT}\n\n${statePrompt}` : SHANNON_CORE_PROMPT;
}
