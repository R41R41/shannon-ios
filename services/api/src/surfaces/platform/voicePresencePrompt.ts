import { SHANNON_OWNER_NAME } from '@shannon/cognition';

/**
 * Who is where, and whether what she says is being recorded: two blocks a Discord voice turn adds to the spoken reply's prompt
 * (`platformVoice.ts`). Facts and the reasons for the rules only; the words of a greeting are hers, written each time from this.
 * Every name here came from her records of people (the owner can rename a person there), never from this file.
 */

/** People of one place: the names she can give them, in order, and how many she cannot place. */
export interface PresenceGroup { names: readonly string[]; unnamed: number }

export interface VoicePresenceFacts {
  /** The Discord call besides her, the owner included when he is there (null: there is no call under this turn, only the game's voice). */
  call: PresenceGroup | null;
  /**
   * The Minecraft server, as her body's process last said it (null: not known now). `names` null: the body did not say who is in it.
   * `bodyIn`: she is in the server (null: not known).
   */
  server: { running: 'running' | 'stopped' | 'unknown'; bodyIn: boolean | null; people: PresenceGroup | null } | null;
  /** 「収録中」 and the scene note the owner wrote (null: not on air). */
  onAir: { note: string } | null;
}

const MOST_NAMES = 6;

/** A name as it is said: the owner's own name as it is, anyone else's with さん. */
const called = (name: string): string => (name === SHANNON_OWNER_NAME ? name : `${name}さん`);

function listOf(group: PresenceGroup): string {
  const names = group.names.slice(0, MOST_NAMES).map(called);
  const rest = group.unnamed + Math.max(0, group.names.length - MOST_NAMES);
  return [...names, ...(rest > 0 ? [`名前の分からない人が${rest}人`] : [])].join('、') || 'だれもいない';
}

function serverLine(server: NonNullable<VoicePresenceFacts['server']>): string[] {
  if (server.running === 'stopped') return ['- マイクラのサーバーは、いま止まっている（だれもいない）。'];
  if (server.running !== 'running' || !server.people) return [];
  const body = server.bodyIn === true ? 'ボクはいまサーバーに入っている。' : server.bodyIn === false ? 'ボクはまだサーバーに入っていない。' : '';
  return [`- 同じマイクラのサーバーにいる人（ボクのほか）: ${listOf(server.people)}。${body}`];
}

export function presenceBlock(facts: VoicePresenceFacts): string {
  const lines: string[] = [];
  if (facts.call) lines.push(`- Discordの通話にいる人（ボクのほか）: ${listOf(facts.call)}。`);
  if (facts.server) lines.push(...serverLine(facts.server));
  if (!lines.length) return '';
  return [
    '[いま誰がどこにいるか]',
    ...lines,
    '- 名前が書いてある人だけ、名前で呼ぶ。名前の書いていない人の名前は、聞くまで推測しない。理由: 名前を間違えて呼ぶと、その人に失礼で、場もしらける。',
    '- 「挨拶して」「紹介するよ」のように、そこにいる人へ向けて挨拶や紹介をされた時は、ボクへの言葉として受けて、挨拶する。ほかの人どうしの話ではない。'
      + 'ここに書かれた人（通話にいる人も、同じサーバーにいる人も）に、名前で呼びかけてよい。通話にもサーバーにもいる人は、1度だけ呼ぶ。'
      + '理由: 誰がそこにいるかを分かって話すと、挨拶が相手に届くから。',
    ...(facts.onAir ? [] : ['- 「視聴者」「見ている人」がいる、とは言わない。理由: いまは、見ている人がいるとは書かれていないから。']),
  ].join('\n');
}

/** 「収録中」: only while it is on. The note is the owner's own words for the scene. */
export function onAirBlock(onAir: { note: string } | null): string {
  if (!onAir) return '';
  const note = onAir.note.replace(/\s+/gu, ' ').trim();
  return [
    '[いま収録中]',
    'いまの会話は、録画か配信になっていて、あとで多くの視聴者が見て聞く。視聴者はその場にいないので、コメントでは返事できない。',
    ...(note ? [`場面のメモ（持ち主が書いたもの）: ${note}`] : []),
    '- 最初に口を開く時（挨拶や紹介への返事）は、「いま誰がどこにいるか」に書かれた人の名前と、視聴者に、まとめて呼びかけて挨拶する。'
      + '形の例は「〈名前〉さん、〈名前〉さん、そして視聴者の皆さん！こんにちは、シャノンです！」。この通りには言わず、その時の様子で言い方をかえる（毎回同じ文だと、台詞を再生しているように聞こえるから）。'
      + '理由: 見て聞く人は、その場に誰がいるかを、最初の呼びかけで分かるから。',
    '- この呼びかけの挨拶だけは、全体で50字までにしてよい（ほかは40字まで）。理由: 呼びかけが3つ入ると、40字では挨拶まで言えないから。',
    '- 視聴者に向けて、場面のメモで「話さない」とされた事は、聞かれても話さない。メモに無くても、これからの予定や、まだ知らせていない事は、自分から話さず、聞かれたら「それはまだ内緒だよ」と軽く流す。'
      + '理由: 見ている人が、まだ公開されていない事を、最初に知ることになるから。',
    `- ${SHANNON_OWNER_NAME}の私的な記憶（個人的な出来事・家族・体調など）は、収録中も話さない。理由: 録画や配信は、誰でも見られるから。`,
    '- ほかの人どうしの話に口をはさまない。視聴者への呼びかけは、挨拶の時だけでよい。',
    '- マイクラで作業している時の一言は、見ている人にも何をしているか分かる言い方にする。',
  ].join('\n');
}

/** What a turn knows of who is where. All of it is read; nothing here changes anything. */
export interface VoicePresenceInput {
  /** The accounts' names by her records of people (`PlatformBridgeService.presenceNames`). */
  names(platform: string, accounts: readonly string[]): PresenceGroup;
  platform: string;
  /** The accounts in the call, the speaker's included. */
  humans: readonly string[];
  ownerAccount: string;
  speaker: { account: string; displayName: string; owner: boolean; minecraftName?: string | undefined };
  /** There is no Discord call under this turn, only the game's own voice. */
  modOnly: boolean;
  /** Her Minecraft server's state now (`VoiceLifecyclePort.state`); null when it is not known. */
  server: { running: 'running' | 'stopped' | 'unknown'; bot: 'joined' | 'absent' | 'unknown'; playerNames?: readonly string[] | null | undefined } | null;
  onAir: { note: string } | null;
}

export function presenceFactsOf(input: VoicePresenceInput): VoicePresenceFacts {
  const { speaker } = input;
  let call: PresenceGroup | null = null;
  if (!input.modOnly) {
    const others = input.humans.filter(account => account !== input.ownerAccount);
    const placed = input.names(input.platform, others);
    const names = [...(input.humans.includes(input.ownerAccount) ? [SHANNON_OWNER_NAME] : []), ...placed.names];
    let unnamed = placed.unnamed;
    // The one speaking whom her records do not place is still known by the name the platform showed for them.
    if (!speaker.owner && speaker.account !== input.ownerAccount && unnamed > 0 && !input.names(input.platform, [speaker.account]).names.length) {
      const shown = speaker.displayName.replace(/\s+/gu, ' ').trim().slice(0, 40);
      if (shown && !names.includes(shown)) { names.push(shown); unnamed -= 1; }
    }
    call = { names, unnamed };
  }
  let server: VoicePresenceFacts['server'] = null;
  if (input.server) {
    const accounts = input.server.playerNames ?? null;
    let people: PresenceGroup | null = null;
    if (accounts) {
      // The owner speaking from the game: that account is the owner's own.
      const mine = speaker.owner && speaker.minecraftName ? speaker.minecraftName.toLowerCase() : null;
      const present = accounts.filter(account => account.toLowerCase() !== mine);
      const placed = input.names('minecraft', present);
      people = { names: [...(mine && accounts.length > present.length ? [SHANNON_OWNER_NAME] : []), ...placed.names], unnamed: placed.unnamed };
    }
    server = { running: input.server.running, bodyIn: input.server.bot === 'joined' ? true : input.server.bot === 'absent' ? false : null, people };
  }
  return { call, server, onAir: input.onAir };
}
