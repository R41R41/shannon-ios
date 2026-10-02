import type {
  VoiceDecisionInput, VoiceSilenceCategory, VoiceTurnDecision, VoiceTurnFacts,
} from './voiceDecisionContract.js';
import { ADDRESS_EVIDENCE, guestAddressDecision, type GuestAddressReason } from './voiceGuestCall.js';

/**
 * When she should not answer in a call with the owner (owner decision 2026-10-02): speech that is
 * not for her, a backchannel that asks nothing, an utterance that is not finished, "wait a moment",
 * and noise or an echo of her own voice. And when she must answer however short the utterance is.
 *
 * Three tiers decide, in the order of the decision gateway: Jev and the OpenAI fallback are told
 * the categories and given the facts of the moment (`replyRequiredQuestion`, `routerTurnState`);
 * the local rules below (`ownerTurnVerdict`) are the third tier, and the floor under the two
 * models: where a rule has an opinion it stands, where it has none the model's answer stands.
 *
 * `SHANNON_VOICE_SILENCE_RULES=off` restores the decision exactly as it was before this module
 * (the router's old question, no `turn` facts, an unclear transcript always answered). A
 * comma-separated list of categories keeps only those rules.
 */
const RULE_CATEGORIES = ['not_addressed', 'backchannel', 'unfinished', 'hold', 'echo'] as const;
export type VoiceSilenceRule = typeof RULE_CATEGORIES[number];

export type VoiceAnswerReason =
  | 'typed' | 'named' | 'answers_her_question' | 'question' | 'request' | 'greeting' | 'called'
  | 'correction' | 'aimed_at_her' | 'reaction';

export type VoiceSilenceVerdict =
  | { respond: true; reason: VoiceAnswerReason }
  | { respond: false; category: VoiceSilenceRule };

type Environment = Readonly<Record<string, string | undefined>>;

/** The rules in force. Empty: the kill switch is on. */
export function voiceSilenceRules(environment: Environment = process.env): ReadonlySet<VoiceSilenceRule> {
  const value = environment.SHANNON_VOICE_SILENCE_RULES?.trim().toLowerCase() ?? '';
  if (['', 'on', 'true', '1', 'yes', 'enabled', 'all'].includes(value)) return new Set(RULE_CATEGORIES);
  if (['off', 'false', '0', 'no', 'disabled', 'none'].includes(value)) return new Set();
  // A list keeps the rules it names. A name it misspells is ignored, never read as "all".
  return new Set(value.split(',').map(item => item.trim()).filter((item): item is VoiceSilenceRule => (RULE_CATEGORIES as readonly string[]).includes(item)));
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value?.trim());
  return value?.trim() && Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/** A short utterance the router could not trust is taken as a fragment up to this many characters (`SHANNON_VOICE_FRAGMENT_CHARACTERS`). */
const fragmentCharacters = (environment: Environment) => boundedNumber(environment.SHANNON_VOICE_FRAGMENT_CHARACTERS, 16, 0, 80);
/** Below this reply-required probability the router's doubt alone is silence (`SHANNON_VOICE_REPLY_SILENCE_BELOW`; 0 switches it off). */
const replySilenceBelow = (environment: Environment) => boundedNumber(environment.SHANNON_VOICE_REPLY_SILENCE_BELOW, 0.15, 0, 1);
/**
 * "Could not trust" for that rule (`SHANNON_VOICE_FRAGMENT_RELIABILITY`). Lower than the 0.85 below which a transcript is
 * re-read in context: a short, ordinary remark the router is merely unsure of must still be answered.
 */
const fragmentReliability = (environment: Environment) => boundedNumber(environment.SHANNON_VOICE_FRAGMENT_RELIABILITY, 0.5, 0, 1);

/** The fragment rule applies only while the router's own reply-required probability is below this. */
const FRAGMENT_REPLY_BELOW = 0.5;
/** Her question stays open for a short answer this long. */
const QUESTION_OPEN_SECONDS = 120;
/** A reaction counts as following her utterance this long after it was stored. */
const FOLLOWS_SECONDS = 30;
/** An echo is her own line coming back while, or just after, her body speaks it; and it is long. */
const ECHO_SECONDS = 30;
const ECHO_CHARACTERS = 12;
const SHORT_ANSWER_CHARACTERS = 28;
/** Fillers, holds and self-talk are short: the three phrase rules do not look at anything longer. */
const PHRASE_RULE_CHARACTERS = 40;

/** The utterance without spaces and punctuation; long vowels are kept (「へー」). */
const bareText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s、。，,.!！?？…・「」『』（）()〜~]/gu, '');
const characters = (text: string) => Array.from(text).length;

/**
 * The words of the three phrase rules, by kind. An utterance is read as a sequence of them, one word at a time
 * from the left and never backing up: a pattern that repeats an alternation takes exponential time on 「あああ…」.
 * What cannot be read this way gets no opinion from these rules, which is the safe side.
 * Within a kind, and between kinds that share a beginning, the longer word comes first.
 */
const PHRASE_WORD = new RegExp([
  // o: said to someone else in the room or on the phone.
  '(?<o>はいはーい|はーい|(?:今|いま|すぐ)(?:行く|いく)(?:よ|ね)?|もしもし|お世話になっております|いらっしゃい(?:ませ)?)',
  // s: said to himself.
  '(?<s>よいしょ|どっこいしょ|よっこいしょ|よっこらしょ|さてと|えーっと|えーと|えっと|あのー|うーんと|(?:なん|何|どこ|どれ|いつ|誰|だれ)だっけ|(?:なん|何)でだろう?'
    + '|おかしいな(?:あ)?|変だな(?:あ)?|まあ?いい(?:か|や)|どこ(?:いった|行った|やった|置いた)(?:かな|っけ)?|固まった|フリーズした)',
  // h: wait. y: sorry. q: a moment. d: just. j: well then.
  '(?<h>(?:待|ま)っ(?:てて|ていて|といて|て)|お待ち|タイム|ストップ)',
  '(?<y>ごめんね?|すみません|すまん)',
  '(?<q>ちょっと|ちょい|少し|すこし|少々|一旦|いったん|一瞬|今)',
  '(?<d>だけ)',
  '(?<j>じゃあ?)',
  // b: a backchannel or filler.
  '(?<b>(?:うんうん|うーん|うん|んー|ん|はい|はあ|は|ええ|えー|えっ|え|へえ|へー|へ|ほう|ほー|ふーん|ふうん|ふむ|ふう|なるほど(?:ね|なあ|な)?|そっか(?:あ)?|そうか(?:あ)?'
    + '|そうなんだ(?:ね)?|そうなの(?:か)?|そうだね|そうですね|そうね|だよね|ですよね|だね|ですね|たしかに|確かに|了解(?:です)?|りょうかい|わかりました|わかった|分かった'
    + '|オッケー|おっけー|ok|おお|おー|おっと|ああ|あー|あっ|あれっ|あれ|あら|あ|まあね|まあ|よし|さて)ー*)',
  // x: what may follow 「待って」.
  '(?<x>ください|下さい|くれる|くれ|もらえる|ほしい|ね|よ|な|を)',
].join('|'), 'uy');

/** One letter per word of the utterance, or null when it is too long or holds anything that is not such a word. */
function phraseKinds(bare: string): string | null {
  if (!bare || characters(bare) > PHRASE_RULE_CHARACTERS) return null;
  let kinds = '';
  for (let index = 0; index < bare.length;) {
    PHRASE_WORD.lastIndex = index;
    const match = PHRASE_WORD.exec(bare);
    const kind = match && Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined)?.[0];
    if (!match || !match[0] || !kind) return null;
    kinds += kind;
    index += match[0].length;
  }
  return kinds;
}
/** 「そっか、ちょっと待ってね」: fillers, an apology, then one or more "wait"s, each with what may follow it. */
const HOLD_KINDS = /^b*y?j?(?:q?d?hx*)+$/u;

const POLITE_QUESTION = /(?:ですか|ますか|でしょうか|ないか|かい)[。.!！…]*$/u;
/** Wondering aloud: a question word that asks nobody in particular. A question mark still makes it a question. */
const WONDERING = /(?:だろう|だろ|かなあ?|かなぁ|っけ|かしら)[。.…、]*$/u;
const TE_REQUEST = /(?<!く|だっ)て(?:ください|下さい|くれる|くれない|くれ|もらえる|ほしい|欲しい|みて|よ|ね)?[。.!！…]*$|(?:読ん|呼ん|選ん|遊ん|頼ん|ない)で(?:ください|下さい|くれ|よ|ね)?[。.!！…]*$|(?:頼む|頼んだ|たのむ)[よね]?[。.!！…]*$/u;
const GREETING = /おはよ|こんにちは|こんばんは|ただいま|おやすみ|ありがと|サンキュー|ごめん|すみません|よろしく|はじめまして|初めまして|久しぶり|ひさしぶり|やっほ|ハロー|お疲れ|おつかれ|いってきます|行ってきます|行ってくる|またね|じゃあね|バイバイ|寝る|出かけ|帰る|帰った|起きた/u;
const CALLING = /^(?:ねえ|ねぇ|ねー|なあ|おーい|おい|あのさ|あのね|聞いて|きいて|ちょっといい|ちょっと聞いて)/u;
const SECOND_PERSON = /君|きみ|あなた|あんた|お前|おまえ|そっち(?:は|も|こそ|の)/u;
const CORRECTION = /^(?:いや|いえ|いいえ)?(?:違う|ちがう|違います|そうじゃな|そうではな)/u;
const AIMED_AT_HER = /寂し|さみし|疲れ|つかれた|しんど|つら|辛い|嬉し|うれし|楽し|悲し|怖|こわい|不安|心配|眠い|ねむい|お腹(?:すい|空い|減っ|へっ)|腹減|暑い|寒い|痛い|最高|やった|できた|終わった|おわった|好き|嫌い|すごい|すげ|かわいい|可愛い|えらい|天才|さすが|むかつく|落ち込|やめろ|うるさい|だめ|ダメ|いいね|いいじゃん|おもしろ|面白|ウケる|うまい|上手|正解|その通り|最悪|無理|やばい|ひどい|難しい|暇/u;
/**
 * Ends in the middle of a word or on a particle that cannot close a sentence. 「は」「に」「も」「から」 are not here:
 * 「天気は」 is a question, 「自由に」 an ending and 「最初から」 a request, so those are the models' to judge.
 */
const CUT_ALWAYS = /(?:[っッ]|を|へ|という|について)$/u;
/** Endings that can close a sentence: a cut only when nothing closes the segment. 「〜んですが」 and 「ラーメンとか」 are left to the models. */
const CUT_OPEN = /(?:けどさ|でさ|てさ)$/u;

const answer = (reason: VoiceAnswerReason): VoiceSilenceVerdict => ({ respond: true, reason });
const ADDRESS_REASON: Readonly<Partial<Record<GuestAddressReason, VoiceAnswerReason>>> = {
  named: 'named', question: 'question', request: 'request', social: 'greeting', reaction: 'reaction',
};

/**
 * The local rules for one utterance of an owner call, or null where they have no opinion.
 * Deterministic and free: no model is called.
 */
export function ownerTurnVerdict(
  transcript: string, facts: VoiceTurnFacts, rules: ReadonlySet<VoiceSilenceRule> = voiceSilenceRules(),
): VoiceSilenceVerdict | null {
  if (!rules.size) return null;
  if (facts.source === 'typed' || facts.source === 'camera') return answer('typed');
  const silent = (category: VoiceSilenceRule): VoiceSilenceVerdict | null => rules.has(category) ? { respond: false, category } : null;
  const text = transcript.normalize('NFKC').trim();
  const bare = bareText(text);
  const marked = /[?？]/u.test(text);
  const length = characters(bare);
  const recent = (seconds: number) => facts.secondsSinceShannon === undefined || facts.secondsSinceShannon <= seconds;
  // (e) Noise, or her own voice coming back through the microphone: a long stretch of the line she is speaking or has just
  // spoken. Not after her question (「紅茶にします」 quotes her to answer her), and not a short quote (「傘を忘れないで」).
  // After her line to a touch the body listens for his answer, and may hear her line instead: that one is still an echo.
  if (!bare) return silent('echo');
  if (!marked && (!facts.sheAsked || facts.answersHerLine) && facts.followsShannon && facts.secondsSinceShannon !== undefined && facts.secondsSinceShannon <= ECHO_SECONDS
    && length >= ECHO_CHARACTERS && bareText(facts.shannonLastLine ?? '').includes(bare)) return silent('echo');
  const kinds = phraseKinds(bare);
  // Her line to a touch, heard by the microphone that opened for his answer: the whole line (her 「なに？」 coming back), or
  // a part that covers at least half of it. A backchannel word is his (after her 「はい？」, his 「はい」 is answered), and so
  // is a greeting or thanks that happens to be in her longer line (「おはよう」「お疲れさま」「ありがとう」).
  if (facts.answersHerLine && !(kinds && /^b+$/u.test(kinds))) {
    const hers = bareText(facts.shannonLastLine ?? '');
    const part = !marked && hers.includes(bare) && length * 2 >= characters(hers) && !GREETING.test(bare) && !ADDRESS_EVIDENCE.social.test(text);
    if (bare === hers || part) return silent('echo');
  }
  const follows = facts.followsShannon && recent(FOLLOWS_SECONDS);
  // Her question is open for a short reply. With someone else there, only right after she asked: 「醤油ある」 a minute later is for the friend.
  const answering = facts.sheAsked && (!facts.othersPresent || follows);
  // (d) 「ちょっと待ってね」: she waits and says nothing.
  if (kinds && HOLD_KINDS.test(kinds)) return silent('hold');
  // (b) A backchannel asks nothing, unless she had just asked: then 「うん」 is the answer.
  if (kinds && /^b+$/u.test(kinds)) return answering ? answer('answers_her_question') : silent('backchannel');
  // (a) Said to himself or to someone else: nothing but such phrases and fillers. After her question 「はーい」「まあいいや」
  // answer her; and alone with her, 「もしもし」 is a greeting to her.
  if (kinds && /^[bso]+$/u.test(kinds)) {
    if (answering) return answer('answers_her_question');
    const rest = bare.replaceAll('もしもし', '');
    const hello = rest !== bare && !facts.othersPresent && (rest === '' || /^b+$/u.test(phraseKinds(rest) ?? ''));
    return hello ? answer('greeting') : silent('not_addressed');
  }
  if (ADDRESS_EVIDENCE.name.test(text)) return answer('named');
  if (answering && length <= SHORT_ANSWER_CHARACTERS) return answer('answers_her_question');
  if (facts.othersPresent) {
    // With someone else there, the table rule of 「友人も一緒」 decides: she answers only when addressed.
    // A plain request (「読んで」) counts as said to her only right after her own utterance; 「醤油とって」 is for the friend.
    if (follows && TE_REQUEST.test(text)) return answer('request');
    const address = guestAddressDecision(text, {
      turns: [], addressedByName: false, introductionStart: false, followsShannonTurn: follows,
    }, 'speech');
    return address.respond ? answer(ADDRESS_REASON[address.reason] ?? 'reaction') : silent('not_addressed');
  }
  if (marked || POLITE_QUESTION.test(text) || (ADDRESS_EVIDENCE.questionWord.test(text) && !WONDERING.test(text))) return answer('question');
  if (ADDRESS_EVIDENCE.request.test(text) || TE_REQUEST.test(text)) return answer('request');
  if (GREETING.test(bare) || ADDRESS_EVIDENCE.social.test(text)) return answer('greeting');
  if (CALLING.test(bare) || SECOND_PERSON.test(text)) return answer('called');
  if (CORRECTION.test(bare)) return answer('correction');
  if (AIMED_AT_HER.test(text)) return answer('aimed_at_her');
  // (c) Cut in the middle of a word or on a particle: wait for the rest.
  // Recognition closes most segments with 「。」, so a full stop does not make 「明日の会議の資料を。」 a sentence.
  // A short utterance is not a fragment for being short (「行こう」「大丈夫」「カレー」): that is left to the models.
  const closed = /[。.!！]$/u.test(text);
  if (CUT_ALWAYS.test(bare) || (!closed && (/[、,]$/u.test(text) || CUT_OPEN.test(bare)))) return silent('unfinished');
  return null;
}

/**
 * Her line asks something: 「〜ですか？」「〜しましょうか。」「〜かな」, anywhere in it (「何にしますか？決まったら教えてくださいね。」).
 * Read generously: a wrong yes only lets a short reply be answered.
 */
const asksSomething = (content: string) => /[?？]/u.test(content) || /(?:か|かな|かね|かい)(?:[。!！]|$)/u.test(content.trim());

/** The facts of the moment for one owner-call utterance, from what the thread already holds. Nothing is stored. */
export function ownerVoiceTurnFacts(input: {
  /** The thread as the router may see it, oldest first. */
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  /** The newest stored message of the thread, for its time. */
  newest?: { role: 'user' | 'assistant'; observedAt: string };
  at: string;
  othersPresent: boolean;
  source?: VoiceTurnFacts['source'];
  /** Her line to a touch that this utterance answers (the body opened its microphone for the answer): a short reply is for her. */
  answersHer?: string | null;
}): VoiceTurnFacts {
  if (input.answersHer) {
    return { sheAsked: true, answersHerLine: true, followsShannon: true, secondsSinceShannon: 0, shannonLastLine: Array.from(input.answersHer).slice(0, 600).join(''),
      othersPresent: input.othersPresent, ...(input.source ? { source: input.source } : {}) };
  }
  const last = input.history.at(-1);
  const followsShannon = last?.role === 'assistant';
  const asked = last?.role === 'assistant' && asksSomething(last.content);
  const line =[...input.history].reverse().find(item => item.role === 'assistant')?.content;
  const elapsed = input.newest?.role === 'assistant' ? (Date.parse(input.at) - Date.parse(input.newest.observedAt)) / 1_000 : NaN;
  const secondsSinceShannon = Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : undefined;
  return {
    followsShannon,
    sheAsked: asked && (secondsSinceShannon === undefined || secondsSinceShannon <= QUESTION_OPEN_SECONDS),
    ...(secondsSinceShannon !== undefined ? { secondsSinceShannon } : {}),
    ...(line ? { shannonLastLine: Array.from(line).slice(0, 600).join('') } : {}),
    othersPresent: input.othersPresent,
    ...(input.source ? { source: input.source } : {}),
  };
}

/**
 * The turn was left unanswered because the words were not his to her: overheard, her own echo, or a fragment.
 * Such a turn runs no command. 「待って」 (hold) and a silence only the router chose are still his words:
 * 「待って」「ストップ」「キャンセル」 pause or stop work exactly as before.
 */
export const notHisWordsToHer = (decision: VoiceTurnDecision): boolean =>
  decision.silence === 'echo' || decision.silence === 'not_addressed' || decision.silence === 'unfinished';

function silenced(decision: VoiceTurnDecision, category: VoiceSilenceCategory): VoiceTurnDecision {
  const { waitingDirection: _waiting, ...rest } = decision;
  return { ...rest, shouldRespond: false, conversationClass: 'no_response', silence: category };
}

function answered(decision: VoiceTurnDecision): VoiceTurnDecision {
  if (decision.shouldRespond) return decision;
  const { silence: _silence, ...rest } = decision;
  return { ...rest, shouldRespond: true, conversationClass: decision.selectedSkills.length ? 'skill_simple' : 'direct' };
}

/**
 * The router's decision for an owner-call utterance, settled against the local rules.
 * Without `facts` (a 「友人も一緒」 call, which has its own table rule) or with the kill switch on,
 * this is the behaviour before the silence rules: an unclear transcript is always answered.
 */
export function settleOwnerVoiceTurn(
  decision: VoiceTurnDecision,
  turn: { transcript: string; facts?: VoiceTurnFacts; uncertain: boolean },
  environment: Environment = process.env,
): VoiceTurnDecision {
  const rules = voiceSilenceRules(environment);
  if (!turn.facts || !rules.size) {
    return turn.uncertain && !decision.shouldRespond ? { ...decision, shouldRespond: true, conversationClass: 'direct' } : decision;
  }
  const verdict = ownerTurnVerdict(turn.transcript, turn.facts, rules);
  if (verdict?.respond) return answered(decision);
  if (verdict) return silenced(decision, verdict.category);
  // No rule has an opinion: the router's own answer stands, and silence is no longer overturned
  // just because the transcript is unclear. Asking to repeat is for an utterance that was addressed to her.
  if (!decision.shouldRespond) return silenced(decision, decision.silence ?? 'model');
  if (decision.source !== 'fallback' && decision.replyRequiredProbability < replySilenceBelow(environment)) return silenced(decision, 'model');
  const reliability = decision.transcriptReliabilityProbability;
  // A fragment is short, untrusted, and not something the router itself wants answered (「火事だ」「倒れた」 are answered).
  if (rules.has('unfinished') && reliability !== undefined && reliability < fragmentReliability(environment)
    && decision.replyRequiredProbability < FRAGMENT_REPLY_BELOW && characters(bareText(turn.transcript)) <= fragmentCharacters(environment)) return silenced(decision, 'unfinished');
  return decision;
}

/** The third tier: what the local rules alone decide. `quiet` false with no `silence` means "answer". */
export function localTurnSilence(input: VoiceDecisionInput): { quiet: boolean; silence?: VoiceSilenceCategory } {
  const verdict = input.turn ? ownerTurnVerdict(input.transcript, input.turn) : null;
  if (verdict) return verdict.respond ? { quiet: false } : { quiet: true, silence: verdict.category };
  // Before the rules, and with them switched off: a bare acknowledgement is the one silent case.
  return { quiet: /^(?:うん|はい|へえ|なるほど|そうなんだ|ふーん)[。！!…]*$/u.test(input.transcript.trim()) };
}

const usesRules = (input: VoiceDecisionInput) => input.turn !== undefined && voiceSilenceRules().size > 0;

/** What Jev and the OpenAI fallback are told about when to stay silent. One text for both. */
export const VOICE_REPLY_DECISION_LINES: readonly string[] = Object.freeze([
  'Should Shannon speak in reply to this utterance? She is in a live voice call and hears everything the microphone picks up, including speech that is not meant for her. Judge from the utterance, recent_context, and turn (she_just_asked, follows_shannon, seconds_since_shannon_spoke, others_present).',
  'Stay silent when: (a) the speech is not addressed to her: self-talk, talking to another person, to the computer, or on the phone; (b) it is a backchannel or filler that asks nothing (うん, そっか, なるほど, あれ?, え?), unless turn.she_just_asked is true, where a short うん, はい or いや is an answer; (c) the utterance is clearly unfinished: cut in the middle of a word, ending on a particle, or an ASR fragment that does not make sense yet. Wait for the rest; (d) the speaker asks her to wait (ちょっと待って); (e) it is noise, or an echo of her own last line.',
  'Speak when: it is a direct question, it says her name (シャノン), it is a request, a greeting or thanks, an emotional remark aimed at her, an answer to her question, or the continuation of an exchange with her, however short it is.',
  'When turn.others_present is true, speak only with evidence that she is addressed: her name, a second-person reference, or a question or reaction directly after her own utterance.',
  'Asking the speaker to repeat is itself a reply. It is right only when she was evidently addressed and the content cannot be understood; otherwise stay silent.',
]);

const LEGACY_REPLY_QUESTION = Object.freeze({
  type: 'noul',
  instructions: 'Should Shannon produce a spoken reply to this utterance? False only for noise, a discarded fragment, or a conversational acknowledgement that naturally needs no response.',
  criteria: { true: 'A spoken response is expected or useful.', false: 'Silence is the most natural response.' },
});
const LEGACY_OPENAI_LINE = 'Use no_response only for noise, abandoned fragments, or acknowledgements where silence is clearly natural. Choose the cheapest sufficient conversation class and a natural spoken affect and delivery.';

/** Jev's `reply_required` question. */
export function replyRequiredQuestion(input: VoiceDecisionInput): { type: string; instructions: string; criteria: { true: string; false: string } } {
  if (!usesRules(input)) return LEGACY_REPLY_QUESTION;
  return {
    type: 'noul',
    instructions: VOICE_REPLY_DECISION_LINES.join(' '),
    criteria: {
      true: 'She is addressed, or an answer is expected or welcome.',
      false: 'Silence is the natural response: she is not addressed, nothing was asked, or the speaker has not finished.',
    },
  };
}

/** The same decision for the OpenAI fallback: `replyRequiredProbability`, and `no_response` as the class. */
export function openAIReplyInstruction(input: VoiceDecisionInput): string {
  if (!usesRules(input)) return LEGACY_OPENAI_LINE;
  return `replyRequiredProbability, and no_response as the conversation class when it is low: ${VOICE_REPLY_DECISION_LINES.join(' ')} Otherwise choose the cheapest sufficient conversation class and a natural spoken affect and delivery.`;
}

/** The facts both model tiers receive beside the utterance. Empty with the kill switch on. */
export function routerTurnState(input: VoiceDecisionInput): { turn?: Record<string, boolean | number> } {
  if (!usesRules(input) || !input.turn) return {};
  const { sheAsked, followsShannon, secondsSinceShannon, othersPresent } = input.turn;
  return { turn: {
    she_just_asked: sheAsked, follows_shannon: followsShannon, others_present: othersPresent,
    ...(secondsSinceShannon !== undefined ? { seconds_since_shannon_spoke: Math.min(secondsSinceShannon, 3_600) } : {}),
  } };
}
