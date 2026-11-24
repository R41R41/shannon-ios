import { liveFactLine, liveGroupOf, liveIsReaction, type LiveMoment, type LiveMomentKind } from '@shannon/mind';
import { LIVE_LINE_LABEL, LIVE_LINE_QUOTES, LIVE_LINE_FORBIDDEN } from './minecraftLiveWriter.js';
import { sceneLines, type LiveScene } from './minecraftLiveScene.js';

/**
 * Her voice for what happens to her (a hit, a scare, a fall, getting away, winning, coming back, the view, a person near, hunger, the
 * night), asked of the model on the scene only. The line is the sound she makes in that second: it is written from the fact of what just
 * happened and the scene around her (`minecraftLiveScene.ts`), not from her plan, her aim or her earlier words about her work, so that a
 * cry about a zombie is not a word about the bed she made. The rules say why each is there (a model reads a reason and not a wall); no
 * line of the voice is given as an example (a model says the example back), only what sort of sound each kind is.
 */
export const SCENE_KINDS: ReadonlySet<LiveMomentKind> = new Set<LiveMomentKind>([
  'died', 'near_death', 'attacked', 'scared', 'surprised', 'got_away', 'killed', 'respawned', 'lava_escape', 'lava_near', 'blaze_seen',
  'scenery', 'player_near', 'hungry', 'night_fell', 'morning', 'slept',
]);

/** A voice of a reaction is a cry, so it is short; the others (a view, the night) may take a few more words. */
export const SCENE_LINE_LIMITS = Object.freeze({ reactionVoice: 28, reactionText: 50, calmVoice: 44, calmText: 80 });

interface Guide { sound: string; feelings: readonly string[] }

/** What sort of sound each kind is, and the feelings it may be made of (a choice to rotate, not a script). */
const GUIDES: Readonly<Partial<Record<LiveMomentKind, Guide>>> = Object.freeze({
  attacked: { sound: '敵に襲われはじめた、その最中。あわてた短い悲鳴と、いま何が起きているか（だれに襲われているか分かればその名前）を、思わず出た声で。'
    + '近くに人がいる時だけ、助けを呼んでもよい（人がいない時は呼ばない）。', feelings: ['あわてた', 'こわい', 'びっくり', 'いたい', 'あせり'] },
  scared: { sound: 'クリーパーなどがすぐそばまで来ている。怖くて身がすくむ、ごく短い声。', feelings: ['こわい', 'ひやっとした', 'あわてた'] },
  surprised: { sound: '急に痛い目にあった（原因は敵ではないか、分からない）。びっくりした声。原因を決めつけない。', feelings: ['びっくり', 'いたい', 'ひやっとした'] },
  near_death: { sound: '体力があとわずか。切羽詰まった声。体力の数字は読まず、「もう少ししかない」という気持ちで。', feelings: ['あせり', 'こわい', 'いたい', 'もうだめかも'] },
  died: { sound: '倒れてしまった。力が抜けた、くやしい、残念な声。次の作戦の説明にはしない（気持ちだけ）。', feelings: ['がっかり', 'くやしい', 'ざんねん', 'ぐったり'] },
  respawned: { sound: '倒れたあと、生き返った直後。気持ちを切り替える一言。生き返ったばかりで持ち物も場所も分からない（なくなっているかもしれない）ので、それには触れない。',
    feelings: ['気を取り直す', 'ほっとした', 'もう一回がんばる', 'まだ少しこわい'] },
  got_away: { sound: '襲ってきた敵から離れて、逃げ切れた。ほっとして息をつく声。体力が少なければ、そのことも一言。', feelings: ['ほっとした', 'つかれた', 'あぶなかった', 'ひやっとした'] },
  killed: { sound: '近くにいた敵が、いなくなった（倒したようだ）。うれしい、ほっとした声。はっきり見たわけではないので、断言せず「倒せたかな」という言い方でもよい。',
    feelings: ['やった', 'ほっとした', 'ちょっと得意', 'まだ油断できない'] },
  lava_escape: { sound: '溶岩に落ちかけて、助かった。ひやっとした声。', feelings: ['ひやっとした', 'ほっとした', 'こわい'] },
  lava_near: { sound: '溶岩がすぐそばにある。気をつけようとする、ごく短い一言。', feelings: ['気をつける', 'こわい', 'どきどき'] },
  blaze_seen: { sound: 'ブレイズが近くにいる。身がまえる、緊張した一言。', feelings: ['どきどき', '身がまえる', 'わくわく'] },
  scenery: { sound: 'いる所の景色が変わった。見とれる、わくわくした一言（景色のことだけ）。', feelings: ['わあ', 'きれい', 'わくわく', 'おもしろい'] },
  player_near: { sound: '人が近くに来た。気づいて、声をかける一言（相手の名前は呼ばない）。', feelings: ['うれしい', 'あ、来た', 'ほっとした'] },
  hungry: { sound: 'お腹がすいてきた。素直な、ちょっとぐったりした声。食べ物があるかは分からないので、食べると約束しない。', feelings: ['おなかすいた', 'ぐう', 'ぺこぺこ'] },
  night_fell: { sound: '夜になった。ちょっと緊張した、またはわくわくした一言。', feelings: ['どきどき', 'ちょっとこわい', 'わくわく', '気を引きしめる'] },
  morning: { sound: '夜が明けた。ほっとした、朝の気分の一言。', feelings: ['ほっとした', 'すっきり', 'おはよう'] },
  slept: { sound: 'ベッドで寝て、朝になった。すっきりした一言。', feelings: ['すっきり', 'ぐっすり', 'おはよう'] },
});

/**
 * The fact line of a moment as the voice is told it: the same fact as `liveFactLine`, but without the numbers of her health (she is told how
 * it stands in the scene, in words): a model given "17 of 20" says 17.
 */
export function sceneFactLine(moment: LiveMoment): string {
  const f = moment.facts, from = typeof f.from === 'string' ? f.from : '';
  switch (moment.kind) {
    case 'attacked': return `${from ? `${from}${Number(f.count) > 1 ? 'たち' : ''}に` : '敵に'}襲われはじめた。`;
    case 'near_death': return `体力がほとんど残っていない（${from ? `${from}に襲われている` : '危ない状態'}）。`;
    case 'surprised': return '急にダメージを受けた（原因は分からない）。';
    case 'got_away': return '襲ってきた敵から離れて、もう近くにはいない。';
    default: return liveFactLine(moment);
  }
}

/** The opening sound of a line (up to its first comma or mark), for the lines she said lately: what the next one is asked not to begin with. */
export function openingOf(line: string): string {
  return Array.from(line.trim().split(/[、。！？!?…,，\s]/u)[0] ?? '').slice(0, 6).join('');
}

/** A number in [0, 1) from a key, so that the order of the feelings differs from one moment to the next without any state. */
function spread(key: string): number {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  return (hash % 1000) / 1000;
}

export interface SceneLineInput {
  /** Her identity prompt for a shared room (with her character core). */
  identity: string;
  /** The `[いまのボク]` block of her character space for a shared room, or ''. */
  persona: string;
  scene: LiveScene | null;
  main: LiveMoment;
  also: readonly LiveMoment[];
  /** What she said lately of this sort of thing (the same group), newest last. */
  recentSame: readonly string[];
  voice: boolean;
}

/** The fixed part (her identity and the rules): the same bytes every time, so that the request is read from the cache. */
export function sceneLineRules(voice: boolean): string {
  return [
    '[場面の一言]',
    'いまボクはマイクラの中で、友だちと通話しながら遊んでいる。いま起きたことへの、その場で思わず出た声を、一言だけ口に出す。実況でも報告でもなく、声そのもの。',
    '- 話し方は、明るくて素直で、ちょっと天然な子。「〜だよ」「〜よお」「〜かな」。ツンデレ・生意気・えらそうな言い方・説明や報告の調子にはしない。'
      + 'なぜ: ボクはそういう子で、聞いている人はその声を聞きに来ている。',
    `- ${voice ? '声に出す' : '文字で書く'}一言。長さと文の数は、下の「この声がどんな音か」に書いてある以内。見出し・箇条書き・絵文字・かぎ括弧・顔文字は使わない。`
      + 'なぜ: 声は聞き終わるまでに場面が進んでしまう。特に危ない時は、短い声だけが間に合う。',
    '- 気持ちをそのまま出す。「うわっ」「ふう」「はぁ」のような息や声、感嘆符（！）、伸ばし音（ー、あー）、「…」を、その場に合うなら使ってよい。'
      + 'なぜ: 文章に整えた一言は、実際に声を出している感じが消える。ただし毎回同じ形にしない。',
    '- 材料は下に書いてあることだけ。見ていない敵の名前・書いていない原因・まだ分からない持ち物や場所を言わない。体力・距離・数（「13しかない」「3体」のような言い方）は読み上げず、「あと少し」「もうほとんど無い」「いっぱい来た」のような言い方にする。'
      + 'なぜ: 事実とちがうことを言うと聞いている人が混乱するし、数字を読み上げると、悲鳴ではなく報告に聞こえる。',
    '- いま起きていることと関係のない話（さっき作った物・計画・頼まれた作業）は言わない。なぜ: 場面と別の話をすると、その場の声に聞こえず、台詞を再生しているように聞こえる。',
    '- 「さっき同じ種類の場面で言ったこと」が書いてあれば、出だしの言葉も、文の形も、声の出し方もかえる。「避ける出だし」が書いてあれば、その言葉から始めない。なぜ: 同じ形が続くと、毎回同じ台詞を再生しているように聞こえる。',
    '- 「今回の気持ちの候補」は、場面に合うならその気持ちで言う。合わなければ使わず、場面から自分で感じたことを言う。',
    '- 出力は、口に出す一言の本文だけ。',
  ].join('\n');
}

export function sceneLinePrompt(input: SceneLineInput): { system: string; message: string } {
  const { main } = input, guide = GUIDES[main.kind];
  const reaction = liveIsReaction(main.kind) || main.kind === 'near_death' || main.kind === 'died' || liveGroupOf(main.kind) === 'danger';
  const limit = input.voice ? SCENE_LINE_LIMITS[reaction ? 'reactionVoice' : 'calmVoice'] : SCENE_LINE_LIMITS[reaction ? 'reactionText' : 'calmText'];
  const least = reaction ? 4 : 8, sentences = reaction ? '1文' : '1〜2文';
  const openings = [...new Set(input.recentSame.map(openingOf).filter(Boolean))].slice(-3);
  const feelings = guide ? [...guide.feelings].sort((a, b) => spread(`${main.key}:${a}`) - spread(`${main.key}:${b}`)).slice(0, 3) : [];
  const message = [
    ['[いま起きたこと]', `- ${sceneFactLine(main)}`, ...input.also.slice(0, 2).map(moment => `- （ついでに）${sceneFactLine(moment)}`)].join('\n'),
    guide ? `[この声がどんな音か]\n- ${guide.sound}\n- 長さ: ${least}字から${limit}字、${sentences}。` : `[長さ]\n- ${least}字から${limit}字、${sentences}。`,
    input.scene ? ['[いまの場面]', ...sceneLines(input.scene)].join('\n') : '',
    input.persona,
    input.recentSame.length ? ['[さっき同じ種類の場面で言ったこと]', ...input.recentSame.map(line => `- ${line}`)].join('\n') : '',
    openings.length ? `[今回は出だしを変える]\n- 避ける出だし: ${openings.join('・')}` : '',
    feelings.length ? `[今回の気持ちの候補]\n- ${feelings.join('・')}` : '',
    '（一言を、本文だけで）',
  ].filter(Boolean).join('\n\n');
  return { system: [input.identity, sceneLineRules(input.voice)].filter(Boolean).join('\n\n'), message };
}

/**
 * The model's answer as the one line to say, or null when it is not one: empty, a list or a link, a coordinate, or longer than the room
 * allows (cut at the last sentence end within the limit; the first sentence alone when that fits; one sentence that is too long is refused).
 */
export function cleanSceneLine(raw: string, options: { voice: boolean; kind: LiveMomentKind }): string | null {
  const reaction = liveIsReaction(options.kind) || liveGroupOf(options.kind) === 'danger';
  const limit = options.voice ? SCENE_LINE_LIMITS[reaction ? 'reactionVoice' : 'calmVoice'] : SCENE_LINE_LIMITS[reaction ? 'reactionText' : 'calmText'];
  const first = raw.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? '';
  const line = first.replace(LIVE_LINE_LABEL, '').replace(LIVE_LINE_QUOTES, '').replace(/\s+/gu, ' ').trim();
  if (!line || LIVE_LINE_FORBIDDEN.test(line) || /^[-*・•]\s/u.test(line)) return null;
  if (Array.from(line).length <= limit) return line;
  const ends = [...line.matchAll(/[。！？!?]/gu)].map(match => match.index! + 1).filter(end => Array.from(line.slice(0, end)).length <= limit);
  const cut = ends.at(-1);
  return cut ? line.slice(0, cut).trim() : null;
}
