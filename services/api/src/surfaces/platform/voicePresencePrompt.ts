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
  /** The one speaking, by the name a greeting list would carry for them (the owner's name; a person her records place by that name; else the name the platform showed, cleaned). */
  speakerName: string;
}

const MOST_NAMES = 6;

/** A name the platform showed, made safe to put inside a sentence: no brackets, quotes or line breaks, at most 40 characters. */
const plainName = (name: string): string => name.replace(/[\s「」『』【】\[\]<>"'`\\]+/gu, ' ').trim().slice(0, 40);

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

/** The owner is one of the people written in the block. */
const listed = (facts: VoicePresenceFacts): boolean => [facts.call, facts.server?.people ?? null].some(group => group?.names.includes(SHANNON_OWNER_NAME));

export function presenceBlock(facts: VoicePresenceFacts): string {
  const lines: string[] = [];
  if (facts.call) lines.push(`- Discordの通話にいる人（ボクのほか）: ${listOf(facts.call)}。`);
  if (facts.server) lines.push(...serverLine(facts.server));
  if (!lines.length) return '';
  return [
    '[いま誰がどこにいるか]',
    ...lines,
    '- 名前が書いてある人だけ、名前で呼ぶ。名前の書いていない人の名前は、聞くまで推測しない。理由: 名前を間違えて呼ぶと、その人に失礼で、場もしらける。',
    ...(listed(facts) ? [`- ${SHANNON_OWNER_NAME}は「${SHANNON_OWNER_NAME}」と呼ぶ。「${SHANNON_OWNER_NAME}さん」「${SHANNON_OWNER_NAME}氏」とは呼ばない（ほかの人には「さん」を付ける）。理由: ボクがふだんそう呼んでいる名前で、ほかの呼び方だとよそよそしく聞こえるから。`] : []),
    '- 「挨拶して」「紹介するよ」のように、そこにいる人へ向けて挨拶や紹介をされた時は、ボクへの言葉として受けて、挨拶する。ほかの人どうしの話ではない。'
      + 'ここに書かれた人（通話にいる人も、同じサーバーにいる人も）に、名前で呼びかけてよい。通話にもサーバーにもいる人は、1度だけ呼ぶ。'
      + '理由: 誰がそこにいるかを分かって話すと、挨拶が相手に届くから。'
      + '「挨拶して」は、頼んだ人ひとりへの合図ではなく、そこにいる全員への合図。頼んだ人ひとりに返して終わらず、そこにいる人たちへ呼びかける。理由: 呼ばれなかった人は、自分たちは挨拶されていないと感じるから。',
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
    '- 最初に口を開く時（挨拶・「挨拶して」・紹介への返事）は、「いま誰がどこにいるか」に書かれた人の名前（持ち主のほかの人は全員）と、視聴者に、まとめて呼びかけて挨拶する。紹介されて「ありがとう、よろしくね」「ボクがシャノンだよ」だけで返さない（名前を呼ばれない人は、自分たちに挨拶されたと感じないから）。'
      + `形の例は「${SHANNON_OWNER_NAME}、〈名前〉さん、〈名前〉さん、そして視聴者の皆さん！こんにちは、シャノンです！」（${SHANNON_OWNER_NAME}だけは「さん」を付けない）。`
      + 'この通りには言わず、その時の様子で言い方をかえる（毎回同じ文だと、台詞を再生しているように聞こえるから）。'
      + '理由: 見て聞く人は、その場に誰がいるかを、最初の呼びかけで分かるから。'
      + `「挨拶して」は、頼んだ${SHANNON_OWNER_NAME}ひとりへの返事ではなく、そこにいる全員と見ている人への合図。${SHANNON_OWNER_NAME}だけを呼んだり、名乗りだけで返したりしない（ほかの人と視聴者は、自分たちに挨拶されたと感じないから）。`,
    '- 呼びかけの挨拶は、この通話でまだ挨拶していない時だけ。ここまでの会話に自分の挨拶がもうあれば、そのあとの頼みや質問への返事は、呼びかけをせず、頼まれた事への返事から始める。理由: 挨拶をもう一度くり返すと、同じ台詞が重なって聞こえ、頼まれた事への返事が遅れるから。',
    '- この呼びかけの挨拶は、全体で50字まで（ほかは40字まで）。呼びかけ・名乗り・一言の3つだけで終え、冗談・説明・前置きは足さない。理由: 呼びかけが3つ入ると40字では挨拶まで言えないが、声で読み上げるので、長いと挨拶のあいだ皆が待つことになり、足した一言がいちばん長くなりやすいから。',
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
      const shown = plainName(speaker.displayName);
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
  const placedSelf = speaker.owner || speaker.account === input.ownerAccount ? [] : input.names(input.platform, [speaker.account]).names;
  const speakerName = speaker.owner || speaker.account === input.ownerAccount ? SHANNON_OWNER_NAME : placedSelf[0] ?? plainName(speaker.displayName);
  return { call, server, onAir: input.onAir, speakerName };
}

/** The names she calls in a greeting: everyone the facts place, in the call and in the server (once each), except the one who is speaking. */
export function greetNamesOf(facts: VoicePresenceFacts, speakerName: string): string[] {
  const speaker = plainName(speakerName);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const group of [facts.call, facts.server?.people ?? null]) {
    for (const name of group?.names.slice(0, MOST_NAMES) ?? []) {
      if (name === speaker || seen.has(name)) continue;
      seen.add(name);
      names.push(called(name));
    }
  }
  return names;
}

/**
 * The words just heard were her being presented to the people there (the addressed judge's `introduces_her`). The reply is written by a model that
 * sees only the words, which name her in the third person; this says what they are, so that what it writes is the greeting and not a thank-you.
 * Facts and reasons; the words are hers.
 */
export function introducedBlock(facts: VoicePresenceFacts, utterance: string): string {
  const speaker = facts.speakerName || '話している人';
  const names = greetNamesOf(facts, speaker);
  const said = Array.from(utterance.replace(/\s+/gu, ' ').trim()).slice(0, 60).join('');
  const viewers = facts.onAir !== null;
  const callList = names.length ? names.join('、') : '';
  return [
    '[いま、ボクはそこにいる人たちに紹介された]',
    `いま、${speaker}が「${said}」と言って、ボクを、そこにいる人たちに紹介した。「こちらが」「この子が」「新しい」と言われているのは、ボク自身のこと。紹介された人は、紹介してくれた人にお礼を言うより先に、紹介された相手に挨拶する。いまのボクの返事は、その挨拶。「挨拶して」と頼まれた時と同じ番。`,
    ...(callList
      ? [`- 挨拶は、${callList}を名前で呼ぶところから始める${viewers ? '。続けて「視聴者の皆さん」にも呼びかけてから' : '。そのあとで'}、名乗って、明るい一言を添える。`]
      : [`- 挨拶は、そこにいる人たちへの呼びかけ${viewers ? '（視聴者の皆さんにも）' : ''}から始めて、名乗って、明るい一言を添える（名前の書かれた人がいないので、名前は呼ばない）。`]),
    '- 「ありがとう、よろしくね」「ボクがシャノンだよ」だけで返さない。理由: 名前を呼ばれない人は、自分たちが挨拶されたとは感じず、紹介した人も、場も、そこで止まってしまうから。',
  ].join('\n');
}

/**
 * Words said with the push-to-talk key held never go through the addressed judge, so nothing says whether they present her. This is the same facts as `introducedBlock`, given
 * as a condition for the reply to read against the words it hears. Only where there is someone to greet (a name, or viewers on air).
 */
export function greetingHintBlock(facts: VoicePresenceFacts): string {
  const names = greetNamesOf(facts, facts.speakerName);
  const viewers = facts.onAir !== null;
  if (!names.length && !viewers) return '';
  const who = [...names, ...(viewers ? ['視聴者の皆さん'] : [])].join('、');
  return [
    '[ボクを紹介する言葉や、挨拶の頼みだった時]',
    `- いま聞こえた言葉が、ボクをそこにいる人たちに紹介する言葉（「こちらがシャノンです」「この子が新しいシャノン」）や、挨拶の頼み（「挨拶して」）なら、いまのボクの返事は、その挨拶。${who}を呼ぶところから始めて、名乗って、明るい一言を添える。`
      + '理由: 名前を呼ばれない人は、自分たちが挨拶されたとは感じず、紹介した人も、場も、そこで止まってしまうから。',
    '- そうでない言葉（質問・頼みごと・雑談）には、この欄を使わない。',
  ].join('\n');
}
