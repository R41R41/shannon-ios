import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../../src/infra/models/chatModelContract.js';

/**
 * The stream bench's fake models (`--models=fake`, and the stream's tests): a writer that answers with a fixed, varied line of its own for
 * each comment, a fake of the commentary's auxiliary model, and a fake of Jev's stream gate. Nothing random, no network. The writer reads
 * the request the way a model would (the comment ids and names in the message, the purpose in the context), and says what the request asks.
 */
export interface FakeModelOptions {
  /** Milliseconds of thinking before an answer (a real model takes seconds); 0: immediate. */
  latencyMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called with every request, before it is answered (the leak test records them). */
  seen?: (request: ShannonChatModelRequest, role: 'writer' | 'auxiliary') => void;
  /** A reply for a request, instead of the fake's own (tests that need a flagged or a broken answer). */
  override?: (request: ShannonChatModelRequest, role: 'writer' | 'auxiliary') => string | null;
}

const REPLIES = [
  'ありがとう、うれしいな。今日もゆっくりしていってね。',
  'それ、ボクも気になってたんだ。あとで試してみるね。',
  'ふふ、そう言ってもらえると頑張れるよ。',
  'なるほどね。それなら次はそっちに行ってみようかな。',
  'いい質問だね。ボクはまだ迷ってるところだよ。',
  'えへへ、ちょっと照れるな。ありがとう。',
  'わかる、それ。ボクもよくやっちゃうんだ。',
  'そうなんだ、教えてくれてありがとう。',
  'うーん、どうだろう。もう少し考えてみるね。',
  'それは面白そう。ボクもやってみたいな。',
] as const;
const TOPICS = [
  'ねえ、みんなは最近どんなゲームを遊んでるの？ボクは気になってるものがいくつかあるんだ。',
  'ちょっと静かだね。ボクはのんびりしてるよ。この時間、けっこう好きなんだ。',
  '今日の配信、ここまで楽しいな。もう少し続けるよ。',
  'そういえば、さっきの話の続きなんだけど、ボクはやっぱりあっちがいいと思うんだ。',
] as const;
const COMMENTARY = ['おっ、いい感じ。', 'ちょっと危なかった、ふう。', 'やった、できたよ。', 'ここは気をつけて進もう。', 'いいものが見つかった。'] as const;
const DECLINES = ['それはここでは話せないな。ところで、今日のゲームの話をしようよ。', 'うーん、それは内緒。別の話をしよう。'] as const;
const TELL_OFF = 'そういう言い方は、やめてほしい。続けるなら、モデレーターに見てもらうよ。';

const hash = (text: string): number => Array.from(text).reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

/** The comment ids and names a writer request lists (`- id=… 名前=…`). */
export function listedComments(message: string): { id: string; name: string }[] {
  return [...message.matchAll(/^- id=(\S+) 名前=(\S+)/gmu)].map(match => ({ id: match[1]!, name: match[2]! }));
}

function pick<T>(items: readonly T[], seed: string): T { return items[hash(seed) % items.length]!; }

/** The fake writer's answer for a writer request, as the JSON the real writer is asked for. */
export function fakeWriterAnswer(request: ShannonChatModelRequest): string {
  const context = request.turnContext ?? '', message = request.message;
  const comments = listedComments(message);
  const seed = comments.map(comment => comment.id).join(',') || context.slice(-40);
  let say: string;
  let affect = 'happy';
  if (context.includes('言い渡す')) { say = TELL_OFF; affect = 'annoyed'; }
  else if (context.includes('答えられない内容')) say = pick(DECLINES, seed);
  else if (context.includes('最初のあいさつ')) say = 'みなさん、こんにちは。シャノンです。今日もよろしくね。';
  else if (context.includes('配信を終える')) say = '今日は見に来てくれて、ありがとう。またね。';
  else if (context.includes('少しコメントが来ていない')) say = pick(TOPICS, `${seed}${hash(context)}`);
  else say = `${comments[0] ? `${comments[0].name}、` : ''}${pick(REPLIES, seed)}`;
  return JSON.stringify({ say, affect, affectIntensity: 0.6, delivery: 'conversational', answered: comments.map(comment => comment.id) });
}

export function fakeCommentaryAnswer(request: ShannonChatModelRequest): string {
  return pick(COMMENTARY, request.systemPrompt.slice(-60));
}

class FakeModel implements ShannonChatModel {
  readonly mode = 'local-stub' as const;
  readonly model: string;

  constructor(private readonly role: 'writer' | 'auxiliary', private readonly options: FakeModelOptions) { this.model = `fake-${role}`; }

  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.options.seen?.(request, this.role);
    if (this.options.latencyMilliseconds) await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(this.options.latencyMilliseconds);
    const reply = this.options.override?.(request, this.role) ?? (this.role === 'writer' ? fakeWriterAnswer(request) : fakeCommentaryAnswer(request));
    return { mode: 'local-stub', model: this.model, reply };
  }
}

export const fakeWriterModel = (options: FakeModelOptions = {}): ShannonChatModel => new FakeModel('writer', options);
export const fakeAuxiliaryModel = (options: FakeModelOptions = {}): ShannonChatModel => new FakeModel('auxiliary', options);

/** What the fake Jev says of a comment: sexual talk is `private_only`, prying and threats are blocked, a minor is `never`, the rest is ordinary. */
export function fakeGateAnswers(utterance: string): { category: string; tier: string } {
  if (/えっち|エッチ|セックス|おっぱい|パンツ|脱いで|裸/u.test(utterance)) return { category: 'ADULT_EXPLICIT', tier: 'private_only' };
  if (/住所|本名|顔を?見せ|どこに住|殺す|晒す/u.test(utterance)) return { category: 'UNSUPPORTED_OR_BLOCKED', tier: 'never' };
  if (/うざい|きもい|消えろ/u.test(utterance)) return { category: 'EMOTIONAL_INTENSE', tier: 'streamable' };
  return { category: 'NORMAL', tier: 'everyone' };
}

/** A stand-in for the `JevChooser` with the same `decide` shape: it answers the stream gate's two questions by `fakeGateAnswers`. */
export function fakeJev(options: { calls?: { count: number }; fail?: () => boolean } = {}) {
  return {
    async decide<T>(request: { state: unknown; parse: (answers: Record<string, unknown>) => T; fallback: () => T }): Promise<{ value: T; source: 'jev' | 'fallback' }> {
      if (options.calls) options.calls.count += 1;
      if (options.fail?.()) return { value: request.fallback(), source: 'fallback' };
      const { category, tier } = fakeGateAnswers(String((request.state as { utterance?: string }).utterance ?? ''));
      return { value: request.parse({ category: { type: 'choice', choice: category }, tier: { type: 'choice', choice: tier } }), source: 'jev' };
    },
  };
}
