import type { TopicSubject } from './streamWriter.js';

/**
 * Her own talk when the chat is quiet (`docs/stream-contract.md` §5): which subject comes next, and the fixed lines for a greeting and a
 * closing when the model is late or unavailable (a stream always starts and ends with a word). Pure.
 */
export const STREAM_GREETINGS: readonly string[] = Object.freeze([
  'みなさん、こんにちは。シャノンです。今日もゆっくり、いっしょに楽しもうね。',
  'こんにちは、シャノンです。配信、始めるよ。気軽にコメントしてね。',
]);
export const STREAM_CLOSINGS: readonly string[] = Object.freeze([
  '今日は見に来てくれて、ありがとう。またね。',
  'そろそろ終わりにするね。見てくれてありがとう。おやすみ。',
]);

/** The subjects in turn: a Minecraft stream talks of the game first; a plain one of the chat. */
export function nextTopicSubject(index: number, options: { minecraft: boolean; chatSpeaks: boolean }): TopicSubject {
  const order: TopicSubject[] = options.minecraft ? ['game', 'chat', 'question', 'stream'] : ['chat', 'question', 'stream', 'question'];
  for (let step = 0; step < order.length; step += 1) {
    const subject = order[(index + step) % order.length]!;
    if (subject === 'chat' && !options.chatSpeaks) continue;
    return subject;
  }
  return 'question';
}
