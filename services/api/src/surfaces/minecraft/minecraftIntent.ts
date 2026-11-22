/**
 * What she would like her Minecraft body to do, as a field of the structured reply of a turn with the owner
 * (`minecraftBody.ts`). No imports: the chat model's parsing reads it without the body's wiring.
 *
 * The owner's requests for the body are a list (`contracts/minecraftQueueContract.ts`), so the kinds say what is done to the list:
 * `task` adds a request (where: `placement`), `message` is words for the request that is running, `stop` stops the whole list,
 * `cancel` / `hold` / `resume` act on one request (`target`, 「#3」 or 「3」; empty is the one running, and for `resume` the whole
 * list), and `move` puts the target request at `placement`. Which of them his words are is hers to judge.
 *
 * `speech` is not about the list: the owner asked how she speaks (`speechMode`) or how often she speaks of her own accord (`speechRate`). It
 * is carried to her voice's body by the voice call alone (`platformVoice.ts`), and only for the owner; every other surface reads it as none.
 *
 * `login` and `logout` are not about the list either: the owner asked her to go into, or out of, the Minecraft server. They carry nothing else, go
 * through the operator's door (`lifecycleRequest.ts`) from the voice call alone, only for the owner, and every other surface reads them as none.
 */
export const MINECRAFT_INTENT_KINDS = ['none', 'task', 'message', 'stop', 'cancel', 'hold', 'resume', 'move', 'speech', 'login', 'logout'] as const;
export type MinecraftIntentKind = typeof MINECRAFT_INTENT_KINDS[number];
export const MINECRAFT_INTENT_PLACEMENTS = ['end', 'next', 'now'] as const;

export interface MinecraftIntent {
  kind: MinecraftIntentKind;
  /** What to do, in her words, for `task` (and the words for `message`). Empty otherwise. */
  goal: string;
  /** For `task` and `move`: after all (`end`), straight after the one running (`next`), before it (`now`). Empty: `end`. */
  placement?: typeof MINECRAFT_INTENT_PLACEMENTS[number] | '';
  /** For `cancel`, `hold`, `resume`, `move`: the request, as 「#3」 or 「3」. Empty: the one running (`resume`: the whole list). */
  target?: string;
  /** For `speech`: how she speaks from now on (at least one of the two is set). */
  speechMode?: SpeechMode;
  /** For `speech`: how often she speaks of her own accord while chatty. */
  speechRate?: SpeechRate;
}

/** What the body is told of an intent: the kinds it has always known. It does the work through the common task, not through this. */
export interface MinecraftBodyIntent {
  kind: 'none' | 'task' | 'stop';
  goal: string;
}

const SPEECH_MODE_WORDS = ['chatty', 'needed', 'silent'] as const, SPEECH_RATE_WORDS = ['low', 'normal', 'high'] as const;
type SpeechMode = typeof SPEECH_MODE_WORDS[number];
type SpeechRate = typeof SPEECH_RATE_WORDS[number];

export const MINECRAFT_INTENT_GOAL_CHARACTERS = 120;
const TARGET_CHARACTERS = 12;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The field of the structured reply by which she asks her Minecraft body to do something. Offered in a turn of the owner only. */
export const MINECRAFT_INTENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string', enum: [...MINECRAFT_INTENT_KINDS],
      description: 'マイクラの体の「依頼の列」への頼み。task=新しい依頼を足す（ゲームの中でしてほしいことをはっきり頼まれた）。'
        + 'message=いま実行中の依頼への言葉（変えてほしい・続けてほしい）。stop=列ぜんたいを止める。cancel=依頼をやめる。hold=依頼を保留する。'
        + 'resume=保留・停止の依頼を戻す。move=列の中で依頼の順番を変える。none=それ以外。'
        + 'speech=持ち主が、これからの話し方（声を出すか・独り言をするか・どのくらいするか）を変えてほしいと言った時だけ（体への頼みではない）。'
        + 'login=マイクラの体をサーバーへ入れてほしいと持ち主が頼んだ時だけ。logout=マイクラの体をサーバーから出してほしいと持ち主が頼んだ時だけ（体への頼みではない）',
    },
    goal: { type: 'string', description: `task か message の時だけ、何をどれだけするか（message は伝える言葉）を${MINECRAFT_INTENT_GOAL_CHARACTERS}字以内で。それ以外は空文字` },
    placement: {
      type: 'string', enum: [...MINECRAFT_INTENT_PLACEMENTS, ''],
      description: 'task と move の時だけ。end=ほかの依頼のあと（あとで・ついでに）。next=いまの依頼のすぐ次。now=いまの依頼を保留して先にやる。それ以外は空文字',
    },
    target: { type: 'string', description: 'cancel・hold・resume・move の時だけ、依頼の番号（「#3」か「3」）。いま実行中の依頼なら空文字。resume の空文字は列ぜんたい。それ以外は空文字' },
    speechMode: {
      type: 'string', enum: [...SPEECH_MODE_WORDS, ''],
      description: 'speech の時だけ。chatty=よく話す（独り言も声にする）。needed=必要な時だけ（独り言はしない。返事・人への問い・作業の完了と危険の知らせだけ声にする）。'
        + 'silent=話さない（声を出さず、返事は文字で出る）。話し方を変えない時（頻度だけ変える時）は空文字。speech 以外は空文字',
    },
    speechRate: {
      type: 'string', enum: [...SPEECH_RATE_WORDS, ''],
      description: 'speech の時だけ。独り言の多さ。low=少なめ。normal=ふつう。high=多め（よく話す時だけ効く）。変えない時は空文字。speech 以外は空文字',
    },
  },
  required: ['kind', 'goal', 'placement', 'target', 'speechMode', 'speechRate'],
});

const words = (value: unknown, limit: number): string => (typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, limit) : '');

const USES_GOAL: ReadonlySet<MinecraftIntentKind> = new Set(['task', 'message']);
const USES_PLACEMENT: ReadonlySet<MinecraftIntentKind> = new Set(['task', 'move']);
const USES_TARGET: ReadonlySet<MinecraftIntentKind> = new Set(['cancel', 'hold', 'resume', 'move']);

/**
 * The intent of a structured reply, or null when it is absent or unreadable. A task or a message without words is nothing, and a move
 * without a target is nothing. The older shape (`kind`, `goal`) is read as before.
 */
export function parsedMinecraftIntent(value: unknown): MinecraftIntent | null {
  if (!isRecord(value) || !(MINECRAFT_INTENT_KINDS as readonly unknown[]).includes(value.kind)) return null;
  const kind = value.kind as MinecraftIntentKind;
  const goal = USES_GOAL.has(kind) ? words(value.goal, MINECRAFT_INTENT_GOAL_CHARACTERS) : '';
  const target = USES_TARGET.has(kind) ? words(value.target, TARGET_CHARACTERS) : '';
  const placement = USES_PLACEMENT.has(kind) && (MINECRAFT_INTENT_PLACEMENTS as readonly unknown[]).includes(value.placement)
    ? value.placement as 'end' | 'next' | 'now' : '';
  if (USES_GOAL.has(kind) && !goal) return null;
  if (kind === 'move' && !target) return null;
  if (kind === 'speech') {
    const speechMode = (SPEECH_MODE_WORDS as readonly unknown[]).includes(value.speechMode) ? value.speechMode as SpeechMode : undefined;
    const speechRate = (SPEECH_RATE_WORDS as readonly unknown[]).includes(value.speechRate) ? value.speechRate as SpeechRate : undefined;
    if (!speechMode && !speechRate) return null;
    return { kind, goal: '', ...(speechMode ? { speechMode } : {}), ...(speechRate ? { speechRate } : {}) };
  }
  return { kind, goal, ...(placement ? { placement } : {}), ...(target ? { target } : {}) };
}

/** What the body is told when nothing else decided: a stop of any kind is a stop, a task is a task, the rest is nothing. */
export function bodyIntentOf(intent: MinecraftIntent): MinecraftBodyIntent {
  if (intent.kind === 'task') return { kind: 'task', goal: intent.goal };
  if (intent.kind === 'stop' || intent.kind === 'cancel' || intent.kind === 'hold') return { kind: 'stop', goal: '' };
  return { kind: 'none', goal: '' };
}
