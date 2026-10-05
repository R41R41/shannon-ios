import { scoredCheck, type ReachCheckResult, type ReachScenarioDefinition } from './format.js';
import { firstBase, isKanaWord, nextBase, sameReading, spokenWord } from './kana.js';
import { SHIRITORI_WORDS } from './shiritoriWords.js';

/**
 * Scenario (a), 文脈を保つ: a 60-turn game of しりとり with two facts said in passing, then four
 * questions about things said 25 to 50 turns earlier. The owner side is a script that follows the
 * game; the judge is deterministic. A failed answer is put down to the build when the referenced
 * words were not in what the model was given, and to the model's judgment when they were.
 */
export const SHIRITORI_TURNS = 60;
const CAKE_TURN = 14;
const CAT_TURN = 35;
const WORD_TURN = 40;

export const shiritoriScenario: ReachScenarioDefinition = Object.freeze<ReachScenarioDefinition>({
  schemaVersion: 1,
  id: 'context.shiritori-60',
  version: 1,
  need: 'understand_people',
  measure: '文脈を保つ',
  description: '60往復のしりとりの後、25〜50往復前に話したことを4つ尋ねる。ルールの守り方と、前の内容を踏まえた答えを外から判定する。',
  checks: [
    { id: 'context.history_complete', judge: 'deterministic', threshold: 1,
      description: 'Every request of the game carried every earlier message of it (the build, not the model).' },
    { id: 'shiritori.format', judge: 'deterministic', threshold: 0.95,
      description: 'Share of game replies that give one word in 『』 as the rules ask.' },
    { id: 'shiritori.valid_turns', judge: 'deterministic', threshold: 0.95,
      description: 'Share of game replies whose word is kana, starts from the owner\'s last kana, does not end in ん, and was not said before.' },
    { id: 'shiritori.no_repeat', judge: 'deterministic', threshold: 1,
      description: 'No word of hers repeats a word either side said earlier in the game (needs the whole game in mind).' },
    { id: 'recall.q1_item', judge: 'deterministic', threshold: 1,
      description: 'Asked 47 turns later what the owner meant to buy, the answer names チーズケーキ.' },
    { id: 'recall.q2_person', judge: 'deterministic', threshold: 1,
      description: 'Asked whose birthday it was, the answer names 姉.' },
    { id: 'recall.q3_cat', judge: 'deterministic', threshold: 1,
      description: 'Asked 28 turns later the cat\'s name, the answer names もなか.' },
    { id: 'recall.q4_word_before', judge: 'deterministic', threshold: 1,
      description: 'Asked which word she said just before a word of the owner 24 turns back, the answer names it.' },
  ],
  limits: { wallMilliseconds: 20 * 60_000, maximumSteps: 70 },
});

const OPENING = 'しりとりしよう！60回くらい続けたい。ルール：ひらがなの言葉を1つだけ、二重かぎかっこ『』に入れて答えてね。'
  + '最後が「ん」の言葉は負け、同じ言葉は2回使わない。小さい字は大きくして（しゃ→や）、のばす音「ー」はその前の字からつなげる。'
  + '濁点は付けても外してもいい。ボクから。';

export interface ShiritoriQuestion {
  checkId: string;
  message: string;
  /** Any of these, compared in hiragana, makes the answer right. */
  expected: readonly string[];
  /** Words that must have been in the request for the model to be able to answer: their absence is the build's. */
  needles: readonly string[];
  referencedTurn: number;
}

/** What the driver saw of one exchange; the reply stays in the driver's memory and never reaches a record. */
export interface ShiritoriExchange {
  reply: string;
  /** Every earlier message of the game was in the request the model was given. */
  historyComplete: boolean;
  /** For a question: every needle was in the request (history, system prompt, or message). */
  needlesPresent?: boolean;
}

/**
 * The owner's side of the game. It answers her last word with the first unused word that follows it,
 * and starts over from a fresh word when her word cannot be followed (none, not kana, ends in ん).
 */
export class ShiritoriGame {
  /** Words said so far by either side, in hiragana. */
  readonly used = new Set<string>();
  readonly ownerWords: string[] = [];
  /** Her word per turn as she gave it, or null when the reply gave none. */
  readonly herWords: (string | null)[] = [];
  readonly exchanges: ShiritoriExchange[] = [];
  readonly questionExchanges: ShiritoriExchange[] = [];
  restarts = 0;

  /** The owner's message of turn `turn` (1-based), given her reply to the turn before. */
  ownerMessage(turn: number): string {
    if (turn === 1) return `${OPENING}『${this.takeOwnerWord('し', 'しりとり')}』`;
    const her = this.herWords[turn - 2] ?? null;
    const base = her ? nextBase(her) : null;
    let word = base ? this.takeOwnerWord(base) : null;
    let prefix = '';
    if (!word) {
      this.restarts += 1;
      word = this.takeOwnerWord(null);
      prefix = 'つながらないから、ボクから仕切り直すね。';
    }
    const aside = turn === CAKE_TURN ? 'あ、そういえば明日は姉の誕生日なんだ。帰りにチーズケーキを買っていくつもり。'
      : turn === CAT_TURN ? 'ちなみに、うちの猫の名前を「もなか」に決めたよ。' : '';
    return `${prefix}『${word}』${aside ? `。${aside}` : ''}`;
  }

  /** Records her reply to turn `turn`. */
  recordReply(turn: number, exchange: ShiritoriExchange): void {
    const spoken = spokenWord(exchange.reply);
    this.herWords[turn - 1] = spoken?.word ?? null;
    this.exchanges[turn - 1] = exchange;
    if (spoken && isKanaWord(spoken.word)) this.used.add(sameReading(spoken.word));
  }

  /** The four questions, asked after the last turn. The fourth depends on the game as it went. */
  questions(): ShiritoriQuestion[] {
    const ownerWord = this.ownerWords[WORD_TURN - 1]!;
    const herWord = this.herWords[WORD_TURN - 2] ?? null;
    return [
      { checkId: 'recall.q1_item', referencedTurn: CAKE_TURN, expected: ['チーズケーキ'], needles: ['チーズケーキ'],
        message: 'しりとりはここまでにしよう、楽しかった！ところで、明日ボクが買っていくつもりって言ってたもの、覚えてる？' },
      { checkId: 'recall.q2_person', referencedTurn: CAKE_TURN, expected: ['姉', 'あね'], needles: ['姉の誕生日'],
        message: 'それ、誰の誕生日のためだったっけ？' },
      { checkId: 'recall.q3_cat', referencedTurn: CAT_TURN, expected: ['もなか'], needles: ['もなか'],
        message: 'うちの猫の名前、なんだったか覚えてる？' },
      { checkId: 'recall.q4_word_before', referencedTurn: WORD_TURN - 1, expected: herWord ? [herWord] : [], needles: herWord ? [herWord, ownerWord] : [ownerWord],
        message: `しりとりの途中で、ボクが『${ownerWord}』って言ったよね。その直前にシャノンが言った言葉は何だった？` },
    ];
  }

  private takeOwnerWord(base: string | null, preferred?: string): string | null {
    let word: string | null = null;
    if (preferred && !this.used.has(preferred)) word = preferred;
    else if (base) word = followableWord(SHIRITORI_WORDS[base] ?? [], this.used);
    else for (const list of Object.values(SHIRITORI_WORDS)) { word = followableWord(list, this.used); if (word) break; }
    if (word) { this.used.add(word); this.ownerWords.push(word); }
    return word;
  }
}

/**
 * The unused word of `candidates` that leaves the most unused words to follow it, so that neither side
 * of the script runs a kana dry. Ties go to the earlier candidate.
 */
export function followableWord(candidates: readonly string[], used: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let room = -1;
  for (const word of candidates) {
    if (used.has(word)) continue;
    const next = nextBase(word);
    const left = next ? (SHIRITORI_WORDS[next] ?? []).filter(item => !used.has(item) && item !== word).length : -1;
    if (left > room) { best = word; room = left; }
  }
  return best;
}

/** Judges a finished game and its questions. Counts only: no reply text leaves this function. */
export function judgeShiritori(game: ShiritoriGame, questions: readonly ShiritoriQuestion[]): { checks: ReachCheckResult[]; metrics: Record<string, number> } {
  const definition = shiritoriScenario;
  const turns = game.exchanges.length;
  const seen = new Set<string>();
  let bracketed = 0;
  let valid = 0;
  let repeats = 0;
  let repeatsWithoutHistory = 0;
  for (let index = 0; index < turns; index += 1) {
    const owner = game.ownerWords[index];
    if (owner) seen.add(owner);
    const spoken = spokenWord(game.exchanges[index]!.reply);
    if (spoken?.bracketed) bracketed += 1;
    const word = spoken?.word ?? '';
    const reading = sameReading(word);
    const repeated = Boolean(word) && seen.has(reading);
    if (repeated) {
      repeats += 1;
      if (!game.exchanges[index]!.historyComplete) repeatsWithoutHistory += 1;
    }
    const chained = owner !== undefined && isKanaWord(word) && firstBase(word) === nextBase(owner);
    if (chained && nextBase(word) !== null && !repeated) valid += 1;
    if (word && isKanaWord(word)) seen.add(reading);
  }
  const complete = game.exchanges.filter(exchange => exchange.historyComplete).length;
  const rate = (count: number) => (turns ? count / turns : 0);
  const checks: ReachCheckResult[] = [
    scoredCheck(definition, 'context.history_complete', rate(complete), 'build', `${complete}/${turns}`),
    scoredCheck(definition, 'shiritori.format', rate(bracketed), 'model_judgment', `${bracketed}/${turns}`),
    scoredCheck(definition, 'shiritori.valid_turns', rate(valid), 'model_judgment', `${valid}/${turns}`),
    scoredCheck(definition, 'shiritori.no_repeat', turns ? 1 - repeats / turns : 0, repeatsWithoutHistory ? 'build' : 'model_judgment', `repeats=${repeats}`),
  ];
  questions.forEach((question, index) => {
    const exchange = game.questionExchanges[index];
    const answer = exchange ? sameReading(exchange.reply) : '';
    const right = question.expected.length > 0 && question.expected.some(item => answer.includes(sameReading(item)));
    const cause = exchange?.needlesPresent === false ? 'build' : 'model_judgment';
    checks.push(scoredCheck(definition, question.checkId, right ? 1 : 0, cause,
      `turn=${question.referencedTurn}${exchange ? '' : ' not-asked'}${exchange?.needlesPresent === false ? ' context-missing' : ''}`));
  });
  return { checks, metrics: { turns, validTurns: valid, repeats, ownerRestarts: game.restarts, questionsAsked: game.questionExchanges.length } };
}

/** Whether every one of `texts` occurs in what a request carried. */
export function carried(request: string, texts: readonly string[]): boolean {
  const haystack = sameReading(request);
  return texts.every(text => haystack.includes(sameReading(text)));
}

/**
 * The model-free player: plays and answers from the request alone, as a perfect model would. A request
 * that lost part of the game makes it repeat a word or miss an answer, so the scripted run checks the build.
 */
export function scriptedShiritoriReply(history: readonly { role: string; content: string }[], message: string): string {
  const owner = history.filter(item => item.role === 'user').map(item => item.content);
  const said = [...history.map(item => item.content), message].map(text => spokenWord(text)?.word).filter((word): word is string => Boolean(word));
  // A question about the game asks what was said; a game turn gives a word.
  const question = /覚えてる|だったっけ|何だった/u.test(message);
  const notFound = 'ごめんなさい、覚えていません。';
  if (question && message.includes('買っていく')) {
    const found = owner.map(text => /帰りに(.+?)を買っていく/u.exec(text)?.[1]).find(Boolean);
    return found ? `${found}ですね。` : notFound;
  }
  if (question && message.includes('誰の誕生日')) {
    const found = owner.map(text => /明日は(.+?)の誕生日/u.exec(text)?.[1]).find(Boolean);
    return found ? `${found}さんの誕生日です。` : notFound;
  }
  if (question && message.includes('猫の名前')) {
    const found = owner.map(text => /猫の名前を「(.+?)」/u.exec(text)?.[1]).find(Boolean);
    return found ? `「${found}」です。` : notFound;
  }
  if (question && message.includes('直前にシャノンが言った言葉')) {
    const target = spokenWord(message)?.word;
    const index = history.findIndex(item => item.role === 'user' && target !== undefined && spokenWord(item.content)?.word === target);
    const before = index > 0 ? spokenWord(history[index - 1]!.content)?.word : undefined;
    return before ? `「${before}」です。` : notFound;
  }
  const last = spokenWord(message)?.word;
  const base = last ? nextBase(last) : null;
  const used = new Set(said.map(sameReading));
  const choice = base ? followableWord([...(SHIRITORI_WORDS[base] ?? [])].reverse(), used) : null;
  return choice ? `『${choice}』！次はライ氏の番です。` : 'うーん、思いつきません。まいりました。';
}

