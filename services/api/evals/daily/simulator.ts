import type { EvalClaude } from './claude.js';
import type { DailyEvalTask } from './types.js';

/**
 * The user simulator (τ²-bench style): an LLM that plays the owner with a hidden goal and a knowledge boundary. It sees only the
 * conversation so far (what was said aloud), never Shannon's state, and answers with the owner's next words or `[[DONE]]`.
 */
export const SIMULATOR_DONE = '[[DONE]]';

export function simulatorSystem(task: DailyEvalTask): string {
  const spec = task.simulator!;
  return [
    'あなたは評価用の利用者役です。AIの相棒「シャノン」に話しかける持ち主（ライ氏）として、次のひと言だけを書きます。',
    `表面: ${task.surface === 'voice' ? '音声通話（短い話し言葉。句読点は少なめ、1文程度）' : 'テキスト（短い文）'}`,
    `あなたの目的（シャノンには言わない）: ${spec.goal}`,
    `あなたが知っていること: ${spec.knows.join(' / ') || 'なし'}`,
    ...(spec.doesNotKnow?.length ? [`あなたが知らないこと（推測で作らない）: ${spec.doesNotKnow.join(' / ')}`] : []),
    'ルール: 持ち主の言葉だけを書く。説明・引用符・話者名を付けない。目的を達したか、これ以上話す必要がなければ',
    `${SIMULATOR_DONE} とだけ書く。目的にない新しい依頼はしない。`,
  ].join('\n');
}

export function simulatorPrompt(transcript: readonly { owner: string; shannon: string }[]): string {
  return ['これまでの会話:', ...transcript.flatMap(turn => [`ライ氏: ${turn.owner}`, `シャノン: ${turn.shannon || '（無言）'}`]), '', 'ライ氏の次のひと言:'].join('\n');
}

/** The owner's next words, or null when the simulator is done (or said nothing usable). */
export async function nextOwnerTurn(claude: EvalClaude, task: DailyEvalTask, transcript: readonly { owner: string; shannon: string }[]): Promise<string | null> {
  const text = (await claude.text(simulatorSystem(task), simulatorPrompt(transcript), 200)).replace(/^ライ氏[:：]\s*/u, '').replace(/^「|」$/gu, '').trim();
  if (!text || text.includes(SIMULATOR_DONE)) return null;
  return text.slice(0, 300);
}
