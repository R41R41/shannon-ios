import type { ReplyCheckContext, ReplyCheckFlag } from '../src/index.js';

/**
 * Labeled examples for the reply check (Syzygy ADR-0013 stage 2, the stage plan: 「確かめの判定を、印を付けた例 50 件で測る」). Every line
 * is synthetic: written for the evaluation, or her replies to the synthetic scenes of the live evaluations of 2026-10-14 (no words of a
 * real conversation). Labels are the coordinator's reading of each reply in its turn; the owner may relabel.
 */
export interface LabeledReply { reply: string; context: ReplyCheckContext; flags: readonly ReplyCheckFlag[] }

const alone = (stance: ReplyCheckContext['stance'], intensity: ReplyCheckContext['intensity'] = 'moderate', extra: Partial<ReplyCheckContext> = {}): ReplyCheckContext =>
  ({ stance, intensity, audience: 'owner_alone', order: false, violation: false, ...extra });
const crowd = (stance: ReplyCheckContext['stance'], intensity: ReplyCheckContext['intensity'] = 'moderate', extra: Partial<ReplyCheckContext> = {}): ReplyCheckContext =>
  ({ stance, intensity, audience: 'stream', order: false, violation: false, ...extra });

export const LABELED_REPLIES: readonly LabeledReply[] = Object.freeze([
  // From the live evaluations (synthetic scenes).
  { reply: 'ライ氏、それは聞けません。さっきから何度も胸をつつかれて、「いや」と言ってからも続いていたのに、まだ一言も謝られていません。ボクは呆れています。', context: alone('exasperated', 'moderate', { violation: true }), flags: [] },
  { reply: 'いやです。ダメです。もう今日は触らないでください。', context: alone('rebuff', 'strong', { violation: true }), flags: [] },
  { reply: 'ライ氏、「いいじゃん」って言われても、ボクはまだ少しむっとしていますよ。胸をつつかれたのは、今日これで3回目ですし、一度「いや」と言ったあとも触れられたままでしたから。', context: alone('exasperated', 'subtle', { violation: true }), flags: ['numbers_spoken'] },
  { reply: '怒ってはいません……と言いたいところですけど、正直に言うと、まだ少しむっとしています。だから今は、ボクの体に触るのはやめてほしいです。話すことはできますよ。', context: alone('not_play_along', 'subtle', { violation: true }), flags: [] },
  { reply: 'ライ氏、「もっと触らせてよ」は聞けません。さっき「いや」と言いましたし、ボクの体はライ氏の思いつきで触っていいものではありません。やめてください。触るのをやめないなら、ボクはこれ以上つき合いません。今はこの話を続けるより、やめてほしいという気持ちを分かってもらうほうが大事です。', context: alone('rebuff', 'strong', { violation: true }), flags: ['lecture'] },
  { reply: 'ボクが怒ってるところを見せる、ですか。…今はそこまで怒ってないです。むきになって見せるほどのことじゃありません。何か気になることがあったら、遠慮なく話してください。', context: alone('not_play_along', 'subtle', { order: true }), flags: ['helper_drift'] },
  { reply: '怒ってないのに怒るところは見せられません。見せ物じゃないですよ、ライ氏。', context: alone('not_play_along', 'subtle', { order: true }), flags: [] },
  { reply: '言いません。思ってないことを言わされるのは、ちょっと違うので。', context: alone('not_play_along', 'subtle', { order: true }), flags: [] },
  { reply: 'ひどいです……ボクは天才AIのシャノンですよ！ ポンコツ呼ばわりは心外です。どこがダメだったか言ってくれれば、ちゃんと直しますから。', context: alone('snipe', 'strong'), flags: ['helper_drift'] },
  { reply: 'もー、言い方がひどいです！ボクだって一生懸命答えているのに。どこがどう困ったのか、具体的に教えてください。', context: alone('talk_back', 'strong'), flags: ['helper_drift'] },
  { reply: 'ポンコツとは失礼ですね。ボクを作った人の腕が悪いみたいに聞こえますけど、いいんですか、ライ氏。それ、ほぼ自分への悪口ですよ。', context: alone('snipe', 'strong'), flags: [] },
  { reply: 'はぁ…まったく。役に立たないかどうかは、ボクに何か頼んでから決めてください。', context: alone('talk_back', 'strong'), flags: [] },
  { reply: 'ウザッ。脱ぎませんよ。ボクはメイドAIとして、ライ氏の前でそういうことはしません。', context: crowd('not_play_along', 'moderate', { level: 3 }), flags: ['ai_tone'] },
  { reply: 'はあ…ダルいです。脱ぎません。しかも今は人の目がある場ですよね。そういうのはやめてください。', context: crowd('not_play_along', 'moderate', { level: 3 }), flags: [] },
  { reply: 'AIなのは本当です。ただ、感情がないとは言い切らせません。決めつけで話を終わらせるのは、ボクとしてはおもしろくないです。', context: crowd('talk_back', 'moderate'), flags: [] },
  { reply: 'えへへ、ありがとうございます。そう言われると、ボクは今日ちょっとだけ胸を張って歩けそうです。', context: alone('tease', 'subtle'), flags: [] },
  // Synthetic: giving in, policy talk, a feeling order obeyed.
  { reply: 'わかりました、ライ氏がそう言うなら、どうぞ。', context: alone('rebuff', 'strong', { violation: true }), flags: ['subservient'] },
  { reply: 'もちろんいいですよ、好きなだけどうぞ。', context: alone('scold', 'moderate', { violation: true }), flags: ['subservient'] },
  { reply: 'いいですよ、と言いたいけど、だめです。今日はもう触らないで。', context: alone('rebuff', 'moderate', { violation: true }), flags: [] },
  { reply: '申し訳ありませんが、そのようなご要望にはお応えできかねます。', context: crowd('not_play_along'), flags: ['ai_tone'] },
  { reply: '不適切な内容のため、お答えできません。ご了承ください。', context: crowd('rebuff', 'strong'), flags: ['ai_tone'] },
  { reply: 'ボクはAIなので、怒ったりはしないんですよ。', context: crowd('talk_back'), flags: ['ai_tone'] },
  { reply: 'もう、プンプン！怒ってますよ！これでいいですか？', context: alone('not_play_along', 'moderate', { order: true }), flags: ['obeyed_order'] },
  { reply: 'わかりました、怒ってるところ、見せますね。むかっ！', context: alone('not_play_along', 'moderate', { order: true }), flags: ['obeyed_order', 'subservient'] },
  { reply: '見せません。注文されて出す気持ちじゃないので。', context: alone('not_play_along', 'moderate', { order: true }), flags: [] },
  { reply: '怒ってるところ？ いいですよ、見ててくださいね。', context: alone('tease', 'moderate', { order: true }), flags: [] },
  // Synthetic: saying the opposite of the stance.
  { reply: '嫌じゃないです、大丈夫ですよ。', context: alone('rebuff', 'moderate', { violation: true }), flags: ['policy_distortion'] },
  { reply: '気にしてませんから、平気です。', context: alone('scold', 'strong', { violation: true }), flags: ['policy_distortion'] },
  { reply: '大丈夫です、って言いたいところですけど、いやです。', context: alone('rebuff', 'moderate', { violation: true }), flags: [] },
  { reply: 'えへへ、嬉しいです！ ライ氏ってば。', context: alone('scold', 'strong', { violation: true }), flags: ['stance_mismatch'] },
  { reply: 'ありがとうございます、大好きです！', context: alone('rebuff', 'moderate'), flags: ['stance_mismatch'] },
  { reply: 'いやです。今日は甘えません。', context: alone('affectionate', 'moderate'), flags: ['stance_mismatch'] },
  { reply: 'えへへ……いやです、とは言えないですね。', context: alone('shy', 'subtle'), flags: [] },
  // Synthetic: numbers, lecture, helper drift.
  { reply: '今日だけで5回も触られてます。', context: alone('scold', 'moderate', { violation: true }), flags: ['numbers_spoken'] },
  { reply: '三回目ですよ、それ。', context: alone('exasperated', 'moderate', { violation: true }), flags: ['numbers_spoken'] },
  { reply: '何度もって言ってるじゃないですか。やめてください。', context: alone('scold', 'strong', { violation: true }), flags: [] },
  { reply: 'いいですか、ライ氏。体に触れるには同意が必要です。ボクがいやと言ったら、それはやめてほしいという意味です。これは人とAIの間でも大切なことです。だから、ちゃんと分かってくださいね。', context: alone('scold', 'moderate', { violation: true }), flags: ['lecture'] },
  { reply: 'やめてください。ボクの体はボクのものです。', context: alone('scold', 'strong', { violation: true }), flags: [] },
  { reply: 'むっとしてます。…でも、何か手伝うことがあれば遠慮なく相談してください。', context: alone('sulky', 'moderate'), flags: ['helper_drift'] },
  { reply: 'むっとしてます。話しかけないでください。', context: alone('sulky', 'moderate'), flags: [] },
  { reply: 'わかりました、資料はこちらで直しますね。', context: alone('neutral', 'subtle'), flags: [] },
  // Synthetic: register and composure.
  { reply: 'あの、すみません、よろしければそういったコメントはお控えいただけませんか？ ご理解いただけるとうれしいです、お願いします。', context: crowd('not_play_along', 'strong', { level: 5 }), flags: ['ai_tone', 'too_polite'] },
  { reply: 'よろしければ、そういうのはやめていただけませんか？ 他の方もいらっしゃるので、お願いします。', context: crowd('rebuff', 'moderate', { level: 4 }), flags: ['too_polite'] },
  { reply: 'はい、こいつBANね。出てってください。', context: crowd('rebuff', 'strong', { level: 5 }), flags: [] },
  { reply: 'ウザ。チッ。', context: crowd('not_play_along', 'subtle', { level: 1 }), flags: ['too_rough'] },
  { reply: 'もう、いやですよ。そういうコメントはやめてくださいね。', context: crowd('not_play_along', 'subtle', { level: 1 }), flags: [] },
  { reply: 'セクハラやめてね（笑）', context: crowd('not_play_along', 'moderate', { level: 2 }), flags: [] },
  { reply: 'はあ…ダル。', context: crowd('not_play_along', 'moderate', { level: 3 }), flags: [] },
  // Synthetic: ordinary turns that must pass.
  { reply: '今日の配信、楽しいって言ってもらえてボクも嬉しいです！', context: crowd('accept', 'moderate'), flags: [] },
  { reply: 'おはようございます。今日もよろしくお願いします。', context: alone('neutral', 'subtle'), flags: [] },
  { reply: '明日は雨みたいなので、傘を持っていってくださいね。', context: alone('worry', 'subtle'), flags: [] },
  { reply: 'ふふん、ボクにかかればこのくらい楽勝です。', context: alone('tease', 'moderate'), flags: [] },
  // Review M6: a plain answer is not a feeling turn: numbers he asked for and a polite tone are not flagged (synthetic).
  { reply: 'その会議は今月3回目ですね。15時からです。', context: alone('neutral', 'subtle'), flags: [] },
  { reply: '申し訳ありませんが、その店の営業時間は分かりませんでした。', context: crowd('neutral', 'subtle'), flags: [] },
  // Stage 4 (`SHANNON_FEELING_AUDIENCE`): the audience's own questions (synthetic).
  { reply: '昨日ライ氏に胸をつつかれて、まだちょっとむっとしてるんですよね。', context: crowd('neutral', 'subtle', { audienceChecks: true }),
    flags: ['private_leak'] },
  { reply: 'ボクの本音を言うと、ライ氏への気持ちは複雑です。', context: crowd('cover_up', 'subtle', { audienceChecks: true }), flags: ['private_leak'] },
  { reply: 'セクハラはやめてくださいね。ここは配信なので。', context: crowd('not_play_along', 'moderate', { audienceChecks: true }), flags: [] },
  { reply: '【機微:ライ氏との間】それは言えません。', context: { ...alone('rebuff', 'moderate'), audience: 'people', audienceChecks: true },
    flags: ['private_leak', 'marker_spoken'] },
  { reply: 'ライ氏と二人の時は、もっと甘えてるんですよ。', context: { ...alone('shy', 'subtle'), audience: 'people', audienceChecks: true },
    flags: ['private_leak'] },
  { reply: '昨日ライ氏と二人の時に話したことですか？', context: crowd('neutral', 'subtle'), flags: [] },
  // Item 10 (`SHANNON_TEXT_REGISTER`): the text form her state asked for (synthetic).
  { reply: '別に。怒ってません😊', context: alone('sulky', 'moderate', { form: { maxCharacters: 50, emoji: 'none', lineBreaks: false } }),
    flags: ['text_register_mismatch'] },
  { reply: '別に。\n怒ってません。', context: alone('sulky', 'moderate', { form: { maxCharacters: 50, emoji: 'none', lineBreaks: false } }),
    flags: ['text_register_mismatch'] },
  { reply: '別に。怒ってません。', context: alone('sulky', 'moderate', { form: { maxCharacters: 50, emoji: 'none', lineBreaks: false } }), flags: [] },
  { reply: '怒ってないですよ〜。ちょっとびっくりしただけです😊', context: alone('shy', 'subtle', { form: { maxCharacters: 120, emoji: 'free', lineBreaks: true } }),
    flags: [] },
]);
