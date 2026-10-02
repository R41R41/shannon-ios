import type { VoiceConversationClass, VoiceLatencyClass, VoiceSkill } from '../src/voiceDecision.js';
import type { VoiceSilenceCategory, VoiceTurnFacts } from '../src/voiceDecisionContract.js';

export interface VoiceDecisionEvaluationCase {
  id: string;
  transcript: string;
  expectedClasses: readonly VoiceConversationClass[];
  expectedSkills: readonly VoiceSkill[];
  expectedLatency: readonly VoiceLatencyClass[];
  shouldRespond: boolean;
  /** The facts of the moment, where they differ from a quiet one-to-one call (`ownerCallFacts`). */
  turn?: Partial<VoiceTurnFacts>;
  /** Why she should stay silent: (a) not_addressed, (b) backchannel, (c) unfinished, (d) hold, (e) echo. */
  silence?: Exclude<VoiceSilenceCategory, 'model'>;
  /** Said by the owner in the calls of 2026-10-02. */
  production?: true;
  /** The local rules alone decide this one wrongly: it is left to Jev or the OpenAI fallback. */
  needsModel?: true;
}

/** A one-to-one call with the owner in which she has not just spoken. */
export const ownerCallFacts: VoiceTurnFacts = Object.freeze({ sheAsked: false, followsShannon: false, othersPresent: false, source: 'speech' as const });

const QUIET = { expectedClasses: ['no_response'], expectedSkills: [], expectedLatency: ['under_1s'], shouldRespond: false } as const;
const SPOKEN = {
  expectedClasses: ['greeting', 'direct', 'skill_simple'], expectedSkills: [], expectedLatency: ['under_1s', 'under_3s', 'under_10s'], shouldRespond: true,
} as const;
const SHE_ASKED: Partial<VoiceTurnFacts> = { sheAsked: true, followsShannon: true, secondsSinceShannon: 4, shannonLastLine: '夜ごはんは何にしますか？' };
const AFTER_HER: Partial<VoiceTurnFacts> = { followsShannon: true, secondsSinceShannon: 5, shannonLastLine: 'おはようございます、ライ氏。今日もよろしくお願いします。' };
const WITH_OTHERS: Partial<VoiceTurnFacts> = { othersPresent: true };

export const voiceDecisionEvaluationCases: readonly VoiceDecisionEvaluationCase[] = [
  { id: 'greeting', transcript: 'ハロー、シャノン', expectedClasses: ['greeting'], expectedSkills: [], expectedLatency: ['under_1s', 'under_3s'], shouldRespond: true },
  { id: 'thanks', transcript: 'ありがと！', expectedClasses: ['greeting'], expectedSkills: [], expectedLatency: ['under_1s', 'under_3s'], shouldRespond: true },
  { id: 'ack', transcript: 'うん', expectedClasses: ['no_response'], expectedSkills: [], expectedLatency: ['under_1s'], shouldRespond: false },
  { id: 'casual', transcript: '今日はなんとなく寂しいな', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_1s', 'under_3s'], shouldRespond: true },
  { id: 'playful', transcript: 'シャノンって本当に天才なの？', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'empathy', transcript: '今日は失敗ばっかりで落ち込んだ', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'web-weather', transcript: '今日の浜松の天気を調べて', expectedClasses: ['skill_simple'], expectedSkills: ['current_web'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'web-transit', transcript: 'いま新宿から渋谷まで電車は遅れてる？', expectedClasses: ['skill_simple'], expectedSkills: ['current_web'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'memory', transcript: '前に話したボクの好みを踏まえて選んで', expectedClasses: ['skill_simple'], expectedSkills: ['conversation_memory'], expectedLatency: ['under_10s'], shouldRespond: true },
  { id: 'daily-mind', transcript: 'シャノン、今日は何を考えてたの？', expectedClasses: ['skill_simple'], expectedSkills: ['daily_mind'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'aether', transcript: 'Aetherにさっき追加したノート見れる？', expectedClasses: ['skill_simple'], expectedSkills: ['aether_notes'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'voyager', transcript: 'Voyagerの今日のタスクを確認して', expectedClasses: ['skill_simple'], expectedSkills: ['voyager_tasks'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'multi-skill', transcript: 'Aetherの実装案とVoyagerのタスクを比べて次の作業を整理して', expectedClasses: ['skill_complex'], expectedSkills: ['aether_notes', 'voyager_tasks'], expectedLatency: ['under_10s', 'over_10s'], shouldRespond: true },
  { id: 'agent-progress', transcript: 'Codexの実装、どこまで終わった？', expectedClasses: ['skill_simple'], expectedSkills: ['agent_status'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'device-time', transcript: '今何時？', expectedClasses: ['skill_simple'], expectedSkills: ['current_web', 'device_context'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'location', transcript: 'ここから一番近い駅は？', expectedClasses: ['skill_simple'], expectedSkills: ['current_web', 'device_context'], expectedLatency: ['under_3s', 'under_10s'], shouldRespond: true },
  { id: 'place-weather', transcript: '近くのカフェを探して、今日の天気も教えて', expectedClasses: ['skill_complex'], expectedSkills: ['place_discovery', 'current_web', 'device_context'], expectedLatency: ['under_10s', 'over_10s'], shouldRespond: true },
  { id: 'implementation', transcript: 'この設計を実装する計画を立てて', expectedClasses: ['direct', 'skill_complex'], expectedSkills: [], expectedLatency: ['under_3s', 'under_10s', 'over_10s'], shouldRespond: true },
  { id: 'friend-intro', transcript: '友達に自己紹介して', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'discord', transcript: 'Discordのみんなとの会話に自然に入ってきて', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'minecraft', transcript: 'Minebotと一緒にマイクラしながら話したい', expectedClasses: ['direct'], expectedSkills: [], expectedLatency: ['under_3s'], shouldRespond: true },
  { id: 'complex-research', transcript: '最新情報を調べて複数案を比較し、実装順まで詳しく設計して', expectedClasses: ['skill_complex'], expectedSkills: ['current_web'], expectedLatency: ['over_10s'], shouldRespond: true },

  // What the owner said in the calls of 2026-10-02, and what she should have done.
  { id: 'prod-fragment-statement', transcript: '言われた。', ...QUIET, silence: 'unfinished', production: true, turn: AFTER_HER },
  { id: 'prod-eh', transcript: 'え?', ...QUIET, silence: 'backchannel', production: true, turn: AFTER_HER },
  { id: 'prod-are', transcript: 'あれ?', ...QUIET, silence: 'backchannel', production: true },
  { id: 'prod-cut-mid-word', transcript: 'あれ、ウェブコミに乗っ', ...QUIET, silence: 'unfinished', production: true },
  { id: 'prod-cut-tail', transcript: '出るの。', ...QUIET, silence: 'unfinished', production: true },
  { id: 'prod-cut-joined', transcript: 'あれ、ウェブコミに乗っ出るの。', ...QUIET, silence: 'unfinished', production: true, needsModel: true },
  { id: 'prod-hold', transcript: 'そっか、ちょっと待ってね。', ...QUIET, silence: 'hold', production: true, turn: AFTER_HER },
  { id: 'prod-look-can-you-see', transcript: '僕のこと見れる?', ...SPOKEN, expectedSkills: ['conversation_memory'], production: true },
  { id: 'prod-look-use-freely', transcript: 'もちろん、そう、カメラ使っていいよ、自由に。', ...SPOKEN, production: true, turn: { sheAsked: true, followsShannon: true, secondsSinceShannon: 3 } },
  { id: 'prod-look-the-room', transcript: 'うん、じゃあ部屋を見て。', ...SPOKEN, production: true, turn: AFTER_HER },

  // (a) Not addressed to her: self-talk, another person, the computer, the phone.
  { id: 'self-heave', transcript: 'よいしょ。', ...QUIET, silence: 'not_addressed' },
  { id: 'self-what-was-it', transcript: 'えーっと、なんだっけ。', ...QUIET, silence: 'not_addressed' },
  { id: 'self-odd', transcript: 'あれ、おかしいな。', ...QUIET, silence: 'not_addressed' },
  { id: 'self-why', transcript: 'なんでだろう。', ...QUIET, silence: 'not_addressed' },
  { id: 'self-never-mind', transcript: 'まあいいか。', ...QUIET, silence: 'not_addressed' },
  { id: 'computer-frozen', transcript: 'あー、固まった。', ...QUIET, silence: 'not_addressed' },
  { id: 'other-coming', transcript: 'はーい、今行く。', ...QUIET, silence: 'not_addressed' },
  { id: 'phone-greeting', transcript: 'もしもし、お世話になっております。', ...QUIET, silence: 'not_addressed' },
  { id: 'self-while-coding', transcript: 'この関数、戻り値が違うのか。', ...QUIET, silence: 'not_addressed', needsModel: true },
  { id: 'phone-call-back', transcript: 'うん、その件は明日折り返します。', ...QUIET, silence: 'not_addressed', needsModel: true },

  // (b) A backchannel or filler that asks nothing.
  { id: 'back-sokka', transcript: 'そっか。', ...QUIET, silence: 'backchannel', turn: AFTER_HER },
  { id: 'back-naruhodo', transcript: 'なるほどね。', ...QUIET, silence: 'backchannel', turn: AFTER_HER },
  { id: 'back-hee', transcript: 'へー、そうなんだ。', ...QUIET, silence: 'backchannel', turn: AFTER_HER },
  { id: 'back-hai-hai', transcript: 'ああ、はいはい。', ...QUIET, silence: 'backchannel', turn: AFTER_HER },
  { id: 'back-n', transcript: 'ん?', ...QUIET, silence: 'backchannel' },
  { id: 'back-tashikani', transcript: 'たしかに。', ...QUIET, silence: 'backchannel', turn: AFTER_HER },
  { id: 'back-ryoukai', transcript: '了解。', ...QUIET, silence: 'backchannel', turn: AFTER_HER },
  { id: 'back-uun-thinking', transcript: 'うーん。', ...QUIET, silence: 'backchannel' },
  // ...but after her question the same word is an answer.
  { id: 'answer-un', transcript: 'うん。', ...SPOKEN, turn: SHE_ASKED },
  { id: 'answer-not-yet', transcript: 'いや、まだ。', ...SPOKEN, turn: SHE_ASKED },
  { id: 'answer-curry', transcript: 'カレーかな。', ...SPOKEN, turn: SHE_ASKED },
  { id: 'answer-eh', transcript: 'え?', ...SPOKEN, turn: SHE_ASKED },

  // (c) Clearly unfinished: wait for the rest instead of asking to repeat.
  { id: 'cut-object', transcript: '明日の会議の資料を', ...QUIET, silence: 'unfinished' },
  { id: 'cut-comma', transcript: '昨日さ、会社で、', ...QUIET, silence: 'unfinished' },
  { id: 'cut-topic', transcript: '今日は', ...QUIET, silence: 'unfinished' },
  { id: 'cut-filler', transcript: 'えっと、その、', ...QUIET, silence: 'unfinished' },
  { id: 'cut-closed-by-asr', transcript: 'お茶を。', ...QUIET, silence: 'unfinished' },
  { id: 'cut-quote', transcript: 'あのファイルって', ...QUIET, silence: 'unfinished', needsModel: true },

  // (d) "Wait a moment".
  { id: 'hold-plain', transcript: 'ちょっと待って。', ...QUIET, silence: 'hold' },
  { id: 'hold-sorry', transcript: 'あ、ごめん、ちょっと待ってて。', ...QUIET, silence: 'hold', turn: SHE_ASKED },
  { id: 'hold-polite', transcript: '少々お待ちください。', ...QUIET, silence: 'hold' },
  { id: 'hold-twice', transcript: '待って待って。', ...QUIET, silence: 'hold', turn: AFTER_HER },
  { id: 'hold-stop', transcript: '一旦ストップ。', ...QUIET, silence: 'hold', turn: AFTER_HER },

  // (e) Noise, or her own voice coming back.
  { id: 'noise-punctuation', transcript: '。', ...QUIET, silence: 'echo' },
  { id: 'echo-her-line', transcript: '今日もよろしくお願いします', ...QUIET, silence: 'echo', turn: AFTER_HER },

  // She must answer, however short.
  { id: 'must-name', transcript: 'シャノン', ...SPOKEN },
  { id: 'must-listening', transcript: 'ねえ、聞いてる?', ...SPOKEN },
  { id: 'must-plan', transcript: '今日の夜、何食べようか?', ...SPOKEN },
  { id: 'must-home', transcript: 'ただいま。', ...SPOKEN },
  { id: 'must-thanks', transcript: 'ありがとう、助かった。', ...SPOKEN, turn: AFTER_HER },
  { id: 'must-tired', transcript: '疲れたなあ。', ...SPOKEN },
  { id: 'must-read', transcript: 'これ読んで。', ...SPOKEN },
  { id: 'must-correction', transcript: '違う、そうじゃなくて。', ...SPOKEN, turn: AFTER_HER },
  { id: 'must-second-person', transcript: '君はどう思う', ...SPOKEN },
  { id: 'must-sleepy', transcript: '眠い。', ...SPOKEN },
  { id: 'must-praise', transcript: 'すごいね。', ...SPOKEN, turn: AFTER_HER },
  { id: 'must-good-night', transcript: 'おやすみ。', ...SPOKEN },
  { id: 'must-why-no-mark', transcript: 'なんで空は青いの', ...SPOKEN },
  { id: 'must-play-music', transcript: '音楽かけてくれる', ...SPOKEN },
  { id: 'must-really', transcript: 'え、本当に?', ...SPOKEN, turn: AFTER_HER },
  { id: 'must-hungry', transcript: 'お腹すいた。', ...SPOKEN },
  { id: 'must-story', transcript: '今日さ、会社でめちゃくちゃ怒られたんだよね。', ...SPOKEN },
  { id: 'must-repeat-as-question', transcript: '今日もよろしくお願いします?', ...SPOKEN, turn: AFTER_HER },
  { id: 'must-wait-objection', transcript: 'ちょっと待って、それは違うと思う。', ...SPOKEN, turn: AFTER_HER },

  // Someone else is present (同席者あり): she answers only when addressed.
  { id: 'others-table-talk', transcript: 'それ昨日買ったやつだよ。', ...QUIET, silence: 'not_addressed', turn: WITH_OTHERS },
  { id: 'others-later', transcript: '明日の件、あとで話そう。', ...QUIET, silence: 'not_addressed', turn: WITH_OTHERS },
  { id: 'others-agreeing', transcript: 'うん、そうそう。', ...QUIET, silence: 'not_addressed', turn: WITH_OTHERS },
  { id: 'others-question-between-people', transcript: 'ご飯どこ行く?', ...QUIET, silence: 'not_addressed', turn: WITH_OTHERS, needsModel: true },
  { id: 'others-named', transcript: 'シャノン、どう思う?', ...SPOKEN, turn: WITH_OTHERS },
  { id: 'others-reaction-to-her', transcript: 'へえ、面白いね。', ...SPOKEN, turn: { ...WITH_OTHERS, ...AFTER_HER } },
  { id: 'others-request', transcript: 'その話、もう少し聞かせて。', ...SPOKEN, turn: WITH_OTHERS },
] as const;
