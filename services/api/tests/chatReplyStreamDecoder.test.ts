import { describe, expect, it } from 'vitest';
import { ChatReplyStreamDecoder } from '../src/infra/models/chatReplyStreamDecoder.js';

const REPLY = '  \n「こんにちは。\n」と "引用" \\ と / と\tタブ 🎉👨‍👩‍👧 終わり。 \n\t ';
const TURN = {
  reply: REPLY, threadSummary: '要約 "reply":"偽の返答" \\" ', taskDecision: { disposition: 'none', reason: '雑談 {"reply":"x"}' },
  taskProposal: null, intentPlan: null, artifacts: [{ name: 'a.md', mimeType: 'text/markdown', content: '"reply":"生成物"', summary: null }],
};

/** The same JSON with every non-ASCII unit written as `\uXXXX`, and `/` escaped: what a provider may also send. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[\u0080-￿]/gu, unit => unit.split('').map(half => `\\u${half.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))
    .replace(/\//gu, '\\/');
}

function decode(pieces: readonly string[], finished = ''): { text: string; decoder: ChatReplyStreamDecoder } {
  const decoder = new ChatReplyStreamDecoder();
  let text = '';
  for (const piece of pieces) {
    text += decoder.push(piece);
    // Whatever is out is already a beginning of the reply the finished turn will carry.
    expect(finished.startsWith(text)).toBe(true);
  }
  return { text, decoder };
}

describe('chat reply stream decoder', () => {
  it.each([['plain', JSON.stringify(TURN)], ['escaped', asciiJson(TURN)], ['pretty', JSON.stringify(TURN, null, 2)]])(
    'gives reply.trim() for a %s completion cut at every position', (_name, json) => {
      expect((JSON.parse(json) as typeof TURN).reply).toBe(REPLY);
      expect(decode([json], REPLY.trim()).text).toBe(REPLY.trim());
      expect(decode(json.split(''), REPLY.trim()).text).toBe(REPLY.trim());
      for (let cut = 0; cut <= json.length; cut += 1) {
        expect(decode([json.slice(0, cut), json.slice(cut)], REPLY.trim()).text, `cut at ${cut}`).toBe(REPLY.trim());
      }
      for (let first = 1; first < json.length; first += 7) {
        for (let second = first + 1; second < json.length; second += 11) {
          expect(decode([json.slice(0, first), json.slice(first, second), json.slice(second)], REPLY.trim()).text).toBe(REPLY.trim());
        }
      }
    });

  it('holds a surrogate pair and an escape until they are whole', () => {
    const decoder = new ChatReplyStreamDecoder();
    expect(decoder.push('{"reply":"a\\ud83c')).toBe('a');
    expect(decoder.push('\\udf')).toBe('');
    expect(decoder.push('89b\\')).toBe('🎉b');
    expect(decoder.push('n')).toBe('');
    expect(decoder.push('c')).toBe('\nc');
    expect(decoder.push('\ud83c')).toBe('');
    expect(decoder.push('\udf89"')).toBe('🎉');
  });

  it('never returns leading whitespace, and trailing whitespace only once more text follows', () => {
    const decoder = new ChatReplyStreamDecoder();
    expect(decoder.push('{"reply":" \\n\\u3000')).toBe('');
    expect(decoder.push('はい。 \\n')).toBe('はい。');
    expect(decoder.push(' \\n')).toBe('');
    expect(decoder.push('次')).toBe(' \n \n次');
    expect(decoder.push(' \\t","threadSummary":"x"}')).toBe('');
    expect(decoder.abandoned).toBe(false);
  });

  it('returns nothing from any field after reply', () => {
    const decoder = new ChatReplyStreamDecoder();
    expect(decoder.push('{"reply":"はい"')).toBe('はい');
    expect(decoder.push(',"threadSummary":"要約","reply":"二つ目","artifacts":[{"content":"本文"}]}')).toBe('');
    expect(decoder.push('"reply":"三つ目"')).toBe('');
  });

  it.each([
    ['another key first', '{"threadSummary":"要約","reply":"はい"}'],
    ['a longer key that begins with reply', '{"replyDraft":"下書き","reply":"はい"}'],
    ['a reply that is not a string', '{"reply":null,"threadSummary":"はい"}'],
    ['a reply object', '{"reply":{"reply":"はい"}}'],
    ['an array', '[{"reply":"はい"}]'],
    ['text before the object', 'はい {"reply":"はい"}'],
    ['an escaped key', '{"\\u0072eply":"はい"}'],
  ])('returns nothing early for %s', (_name, json) => {
    for (const pieces of [[json], json.split('')]) {
      const { text, decoder } = decode(pieces);
      expect(text).toBe('');
      expect(decoder.abandoned).toBe(true);
    }
  });

  it('stops at an invalid escape instead of guessing', () => {
    const decoder = new ChatReplyStreamDecoder();
    expect(decoder.push('{"reply":"はい\\x41まだ","threadSummary":"x"}')).toBe('はい');
    expect(decoder.push('続き')).toBe('');
    expect(decoder.abandoned).toBe(true);
  });
});
