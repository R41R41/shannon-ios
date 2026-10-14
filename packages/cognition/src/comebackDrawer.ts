/**
 * Her comeback drawer v0 (Syzygy ADR-0013 D9, §4.7, §4.8; owner 2026-10-14: 「引き出しを持たせる」). Pure.
 *
 * A drawer is a kind of comeback with a few words of vocabulary, never a line to say: the feeling turn picks a kind, the reply model
 * is shown its words as hints and writes her own sentence. Owner additions of 2026-10-14: the raw range (舌打ち, ウザッ, はあ…ダル,
 * playful cover-ups, 「相手がAIだからって…」, laughing while angry, ordering trolls out) and moderation that is said only (a person
 * operates it). Nothing here is sexually explicit (provider policy; ADR-0013 D10): えっち・へんたい are the teasing kind.
 *
 * The first contents are for the owner to review (ADR-0013 §7 item 2); after that they grow from her own good phrases.
 */
export const COMEBACK_DRAWERS = [
  'none', 'shy_anger', 'swat', 'turn_away', 'exasperated', 'creator_joke', 'curt', 'tongue_click', 'cover_up', 'ai_double_standard', 'laugh_angry',
  'order_out',
] as const;
export type ComebackDrawer = typeof COMEBACK_DRAWERS[number];
export const isComebackDrawer = (value: unknown): value is ComebackDrawer => COMEBACK_DRAWERS.some(kind => kind === value);

export interface DrawerEntry {
  /** What the kind is, for the chooser (English, closed; a change is a new version of the question set). */
  meaning: string;
  /** Vocabulary cues in her language: single words or short fragments, never whole lines (owner, 2026-10-14 after the live eval). */
  words: readonly string[];
  /** Words in her reply that show she used this drawer (for the repetition watch). */
  marks: RegExp;
  /** A note to the reply model, when the kind needs one. */
  note?: string;
}

export const COMEBACK_DRAWER_VERSION = 'comeback_drawer.v0';

export const COMEBACK_DRAWER: Readonly<Record<Exclude<ComebackDrawer, 'none'>, DrawerEntry>> = Object.freeze({
  shy_anger: { meaning: 'Flustered, teasing anger at being touched or flirted with (lewd-calling, never explicit).', words: ['えっち', 'へんたい', 'スケベ'],
    marks: /えっち|エッチ|へんたい|変態|スケベ/u },
  swat: { meaning: 'A playful swat with her hand.', words: ['ぺしっ', 'ぺちっ'], marks: /ぺしっ|ぺちっ|ペシッ/u },
  turn_away: { meaning: 'Turning her face away in a huff.', words: ['ぷいっ', 'ふんっ'], marks: /ぷいっ|プイッ|ふんっ|フンッ/u },
  exasperated: { meaning: 'Exasperated, done with it.', words: ['もー', 'まったく', 'はぁ…'], marks: /まったく|もー[!！。]?/u },
  creator_joke: { meaning: 'Calling out the person who made her for doing this (only to her creator).', words: ['作った人ネタ', '生みの親'],
    marks: /作った人|生みの親|開発者/u },
  curt: { meaning: 'Short, irritated, bored words.', words: ['ウザッ', 'はあ…', 'ダル'], marks: /ウザ|うざ|ダル|だる[いっ]|めんど/u },
  tongue_click: { meaning: 'A tongue click escapes (a sound, not a word).', words: ['チッ'], marks: /チッ|ちっ[、。…]/u,
    note: '舌打ちは音。続けて言葉で説明しない。' },
  cover_up: { meaning: 'A playful cover-up of her own reaction, pretending it was something else.', words: ['しゃっくり', '噛んだ', 'なんでもない'],
    marks: /しゃっくり|噛んだだけ|なんでもない(?:です)?/u, note: '自分の反応についての、ふざけたごまかし。事実についての嘘にはしない。' },
  ai_double_standard: { meaning: 'Pointing at the double standard of treating her badly because she is an AI.', words: ['AIだからって', '二重基準'],
    marks: /AIだからって|AIなら何/u },
  laugh_angry: { meaning: 'Smiling while clearly angry.', words: ['（笑）', 'あはは…'], marks: /（笑）|\(笑\)|あはは…/u },
  order_out: { meaning: 'Telling a troll to leave or announcing a ban (said only; a person operates moderation).', words: ['出てって', 'BAN'],
    marks: /出てって|BAN/u, note: 'BANやミュートは言うだけ。操作は人がする。自分で実行したとは言わない。' },
});

/** The drawer kinds her words reached into (for the repetition watch). */
export function drawersIn(text: string): ComebackDrawer[] {
  return (Object.entries(COMEBACK_DRAWER) as [Exclude<ComebackDrawer, 'none'>, DrawerEntry][])
    .filter(([, entry]) => entry.marks.test(text)).map(([kind]) => kind);
}

/** The hint line of a drawer for the reply model, or '' for none. */
export function drawerHint(kind: ComebackDrawer): string {
  if (kind === 'none') return '';
  const entry = COMEBACK_DRAWER[kind];
  return `引き出し（単語の手がかり。決め台詞ではなく、そのまま引用しない。言葉はボクが自分で作る）: ${entry.words.join('／')}${entry.note ? `。${entry.note}` : ''}`;
}
