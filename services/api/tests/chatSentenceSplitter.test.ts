import { describe, expect, it } from 'vitest';
import { CHAT_SENTENCE_MAXIMUM_LENGTH, ChatSentenceSplitter, splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';

/** Every case is also checked for the two properties the contract states. */
function split(text: string): string[] {
  const sentences = splitChatSentences(text);
  expect(sentences.join('')).toBe(text);
  for (const cuts of [1, 2, 3, 7, 13]) {
    const splitter = new ChatSentenceSplitter();
    const streamed: string[] = [];
    for (let index = 0; index < text.length; index += cuts) streamed.push(...splitter.append(text.slice(index, index + cuts)));
    streamed.push(...splitter.flush());
    expect(streamed, `fed ${cuts} characters at a time`).toEqual(sentences);
  }
  return sentences;
}

describe('chat sentence splitter', () => {
  it('cuts after Japanese and ASCII terminators and keeps the text unchanged', () => {
    expect(split('聞こえてるよ。元気？うん！Really? Yes!')).toEqual(['聞こえてるよ。', '元気？', 'うん！', 'Really? ', 'Yes!']);
    expect(split('すごい！？ほんとに。。。そう')).toEqual(['すごい！？', 'ほんとに。。。', 'そう']);
  });

  it('keeps trailing text without a terminator as the last sentence', () => {
    expect(split('まず答えるね。続きはあとで')).toEqual(['まず答えるね。', '続きはあとで']);
    expect(split('ひとことだけ')).toEqual(['ひとことだけ']);
    expect(split('')).toEqual([]);
  });

  it('does not cut inside 「」『』（） and takes a closing mark that follows a terminator', () => {
    expect(split('ライ氏は「行くよ。待ってて！」と言いました。次です。')).toEqual(['ライ氏は「行くよ。待ってて！」と言いました。', '次です。']);
    expect(split('『銀河鉄道の夜。』を読みました（途中まで。まだ半分！）。面白いです。'))
      .toEqual(['『銀河鉄道の夜。』を読みました（途中まで。まだ半分！）。', '面白いです。']);
    expect(split('そうです。」次の文。')).toEqual(['そうです。」', '次の文。']);
  });

  it('lets a blank line end a quotation that was never closed', () => {
    expect(split('彼は「行くよ。待ってて\n\n次の段落です。終わり。')).toEqual(['彼は「行くよ。待ってて\n\n', '次の段落です。', '終わり。']);
    // One newline inside a quotation is not a boundary.
    expect(split('「一行目。\n二行目。」です。次。')).toEqual(['「一行目。\n二行目。」です。', '次。']);
  });

  it('treats newlines as boundaries and leaves the whitespace on the sentence before', () => {
    expect(split('まず答えるね。\n  続きです\n\n- 一つ目\n- 二つ目\r\n終わり'))
      .toEqual(['まず答えるね。\n  ', '続きです\n\n', '- 一つ目\n', '- 二つ目\r\n', '終わり']);
    expect(split('終わりです。\n')).toEqual(['終わりです。\n']);
    for (const sentence of split('一。 \n\n 二。　三。')) expect(sentence.trim()).not.toBe('');
  });

  it('does not cut inside a URL or a Markdown link', () => {
    expect(split('ここです https://example.com/search?q=shannon&x=1!2 を見てください。次。'))
      .toEqual(['ここです https://example.com/search?q=shannon&x=1!2 を見てください。', '次。']);
    expect(split('[地図](https://maps.apple.com/?q=a!b)を開いて。次。')).toEqual(['[地図](https://maps.apple.com/?q=a!b)を開いて。', '次。']);
    expect(split('http://a.example/?x。次')).toEqual(['http://a.example/?x。', '次']);
    expect(split('key?value=1 のままです。')).toEqual(['key?value=1 のままです。']);
  });

  it('keeps a code fence whole', () => {
    const fence = '```swift\nlet a = 1\n\nprint("Hi!") // どう？\n```\n';
    expect(split(`こう書きます。\n${fence}以上です。`)).toEqual(['こう書きます。\n', fence, '以上です。']);
    expect(split('`a!` は `b?` です。次。')).toEqual(['`a!` は `b?` です。', '次。']);
    expect(split('`a!` だよ。次！`b`。')).toEqual(['`a!` だよ。', '次！', '`b`。']);
  });

  it('keeps emoji and other astral characters intact', () => {
    expect(split('やった🎉！次は😀です。👍')).toEqual(['やった🎉！', '次は😀です。', '👍']);
    const long = '👨‍👩‍👧‍👦'.repeat(60);
    for (const sentence of split(long)) {
      expect(sentence).not.toMatch(/^[\uDC00-\uDFFF‍]/u);
      expect(sentence).not.toMatch(/[\uD800-\uDBFF‍]$/u);
    }
  });

  it('forces a cut in a long run, at a comma or space when one is near', () => {
    const run = 'あ'.repeat(CHAT_SENTENCE_MAXIMUM_LENGTH * 2 + 50);
    expect(split(run).map(sentence => sentence.length)).toEqual([CHAT_SENTENCE_MAXIMUM_LENGTH, CHAT_SENTENCE_MAXIMUM_LENGTH, 50]);

    const clauses = `${'い'.repeat(150)}、${'う'.repeat(150)}、${'え'.repeat(80)}。次。`;
    expect(split(clauses)).toEqual([`${'い'.repeat(150)}、`, `${'う'.repeat(150)}、`, `${'え'.repeat(80)}。`, '次。']);

    for (const text of [run, clauses, `「${'お'.repeat(700)}。」です。`, `\`\`\`\n${'x = 1\n'.repeat(120)}\`\`\`\n後。`, `https://example.com/${'a'.repeat(500)} です。`]) {
      for (const sentence of split(text)) expect(sentence.trimEnd().length).toBeLessThanOrEqual(CHAT_SENTENCE_MAXIMUM_LENGTH);
    }
  });

  it('gives the same sentences however the text arrives, for varied text', () => {
    const pieces = ['こんにちは。', '「', '」', '（', '）', '!', '?', '\n', '\n\n', ' ', 'https://a.b/c?d=e', '```', '`', '`x!y`', 'abc', '🎉', '、', '長い'.repeat(40), '。', '！', '？', 'h', 'ht', 'http'];
    let seed = 20261002;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let round = 0; round < 3000; round += 1) {
      const text = Array.from({ length: 1 + Math.floor(random() * 30) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
      const whole = splitChatSentences(text);
      expect(whole.join('')).toBe(text);
      if (text.trim()) for (const sentence of whole) expect(sentence.trim(), JSON.stringify(text)).not.toBe('');
      const splitter = new ChatSentenceSplitter();
      const streamed: string[] = [];
      for (let index = 0; index < text.length;) {
        const size = 1 + Math.floor(random() * 9);
        streamed.push(...splitter.append(text.slice(index, index + size)));
        index += size;
      }
      streamed.push(...splitter.flush());
      expect(streamed, JSON.stringify(text)).toEqual(whole);
    }
  });
});
