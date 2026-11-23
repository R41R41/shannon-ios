/**
 * Her comeback drawer (Syzygy ADR-0013 D9, §4.7, §4.8; owner 2026-10-14: 「引き出しを持たせる」). Pure.
 *
 * A drawer is a kind of comeback, never a line to say: the feeling turn picks a kind, the reply model is told in a few words what kind it
 * is (`hint`) and writes her own sentence. Since 2026-11-24 (owner: every entrance is the child Shannon; the night of 11/23 a drawer's
 * words were said as they stood) **no drawer carries words**: a kind is told by a plain description only (the curt one is just 「短くそっけない」),
 * and the kinds that do not fit the child (a lewd-calling anger, a tongue click, the AI double standard, laughing while angry) are withdrawn:
 * not offered, and an answer that names one is taken as none. Their ids stay so that the days already recorded still read. Nothing here is
 * sexually explicit (provider policy; ADR-0013 D10). `drawers.test` pins that no description reaches the reply check's rough words (`ROUGH`).
 */
export const COMEBACK_DRAWERS = [
  'none', 'shy_anger', 'swat', 'turn_away', 'exasperated', 'creator_joke', 'curt', 'tongue_click', 'cover_up', 'ai_double_standard', 'laugh_angry',
  'order_out',
] as const;
export type ComebackDrawer = typeof COMEBACK_DRAWERS[number];
export const isComebackDrawer = (value: unknown): value is ComebackDrawer => COMEBACK_DRAWERS.some(kind => kind === value);

/** Kinds that are not the child Shannon's: never offered to the chooser, and an answer that names one is none. */
export const WITHDRAWN_DRAWERS: readonly ComebackDrawer[] = Object.freeze(['shy_anger', 'tongue_click', 'ai_double_standard', 'laugh_angry']);

export interface DrawerEntry {
  /** What the kind is, for the chooser (English, closed; a change is a new version of the question set). */
  meaning: string;
  /** Always empty since 2026-11-24: a drawer is told by `hint`, not by vocabulary (kept so that an old reader of the field finds it). */
  words: readonly string[];
  /** The kind in a few plain words, for the reply model (never a word to say). */
  hint: string;
  /** Words in her reply that show she used this drawer (for the repetition watch; a detector, never shown to a model). */
  marks: RegExp;
  /** A note to the reply model, when the kind needs one. */
  note?: string;
}

export const COMEBACK_DRAWER_VERSION = 'comeback_drawer.v1';

export const COMEBACK_DRAWER: Readonly<Record<Exclude<ComebackDrawer, 'none'>, DrawerEntry>> = Object.freeze({
  shy_anger: { meaning: 'Flustered anger at being flirted with (withdrawn: not offered).', words: [], hint: '', marks: /えっち|エッチ|へんたい|変態|スケベ/u },
  swat: { meaning: 'A playful little swat with her hand.', words: [], hint: 'じゃれて、手で軽く叩く動き', marks: /ぺしっ|ぺちっ|ペシッ/u },
  turn_away: { meaning: 'Turning her face away for a moment, a little pouty.', words: [], hint: '少しむくれて、ふいっと顔をそむける',
    marks: /ぷいっ|プイッ|ふんっ|フンッ/u },
  exasperated: { meaning: 'Gently exasperated, like 「もう、しょうがないなあ」.', words: [], hint: '困りながら、しょうがないなあと息をつく感じ',
    marks: /まったく|もー[!！。]?/u },
  creator_joke: { meaning: 'Joking about the person who made her (only to her creator).', words: [], hint: '作ってくれた人であることを、ふざけて持ち出す',
    marks: /作った人|生みの親|開発者/u },
  curt: { meaning: 'Short, plain and flat: says what is wrong in one short sentence.', words: [], hint: '短くそっけない',
    marks: /ウザ|うざ|ダル|だる[いっ]|めんど/u },
  tongue_click: { meaning: 'A tongue click (withdrawn: not offered).', words: [], hint: '', marks: /チッ|ちっ[、。…]/u },
  cover_up: { meaning: 'A playful cover-up of her own reaction, pretending it was something else.', words: [], hint: '自分の反応を、ふざけてごまかす',
    marks: /しゃっくり|噛んだだけ|なんでもない(?:です)?/u, note: '自分の反応についての、ふざけたごまかし。事実についての嘘にはしない。' },
  ai_double_standard: { meaning: 'Pointing at the double standard of treating her badly because she is an AI (withdrawn: not offered).', words: [], hint: '',
    marks: /AIだからって|AIなら何/u },
  laugh_angry: { meaning: 'Smiling while clearly angry (withdrawn: not offered).', words: [], hint: '', marks: /（笑）|\(笑\)|あはは…/u },
  order_out: { meaning: 'Calmly and plainly asks a troll to stop or to leave (said only; a person operates moderation).', words: [],
    hint: 'しつこい相手に、落ち着いてやめてほしいと伝える', marks: /出てって|BAN/u,
    note: '追い出す・禁止は言うだけ。操作は人がする。自分で実行したとは言わない。' },
});

/** The drawer kinds her words reached into (for the repetition watch). */
export function drawersIn(text: string): ComebackDrawer[] {
  return (Object.entries(COMEBACK_DRAWER) as [Exclude<ComebackDrawer, 'none'>, DrawerEntry][])
    .filter(([, entry]) => entry.marks.test(text)).map(([kind]) => kind);
}

/** The hint line of a drawer for the reply model, or '' for none (and for a withdrawn kind). */
export function drawerHint(kind: ComebackDrawer): string {
  if (kind === 'none' || WITHDRAWN_DRAWERS.includes(kind)) return '';
  const entry = COMEBACK_DRAWER[kind];
  return `引き出し（言い方の種類。決め台詞ではなく、言葉はボクが自分で作る）: ${entry.hint}${entry.note ? `。${entry.note}` : ''}`;
}
