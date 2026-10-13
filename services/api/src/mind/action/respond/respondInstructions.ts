/** The fixed instructions of a reply, by channel (Syzygy ADR-0008 stage 3, S3: the voice reply's, moved unchanged out of the chat model adapter into the respond action; every adapter sends the same words). */


export const VOICE_REPLY_INSTRUCTIONS = '[音声専用の返答]\n自然な日本語の話し言葉で、最初に答えを置く。挨拶と通常会話は1〜2文、複雑な回答でも原則3文に収める。ただし相手が長い話・物語・長めのセリフなどをはっきり求めたときは、求められた長さで最後まで話してよい。Markdown、URL一覧、内部処理の説明、JSONは使わない。聞き取りやすい短い文にし、必要がなければ末尾に質問を足さない。';

/**
 * A question whose answer must be worked out from facts (owner feedback 2026-10-13: asked 「17時に福岡空港にいるには何時に出ればいい？」,
 * she gave only the travel time): the conclusion he asked for comes first, with a sensible margin, and the basis after it.
 * The Claude text reply (`CLAUDE_TEXT_LINES`) and the Claude voice reply (`SHORT_VOICE_REPLY_INSTRUCTIONS`) carry it.
 */
export const COMPUTED_ANSWER_LINE = '「何時に出ればいい？」「いくら要る？」「どっちがいい？」のように、事実から計算や判断がいる質問には、材料（所要時間など）だけで終えず、'
  + '聞かれたことへの結論を最初に言う（例:「16時半ごろ出れば余裕です。空港まで16分ほどです」）。'
  + '結論には乗り換えや混み具合を見込んだ無理のない余裕を含め、根拠はそのあとに短く添える。';

/**
 * Talking as one who always has the conversation in mind (owner feedback 2026-10-13: 「『前の話を確認しますね。』って必要ある？
 * 常に文脈は把握してほしい」, and a conversation audit the same day: an answer that moved from 「17時頃」 to 「17時10分ごろ」 without
 * a word, a place he had just said asked again, 「見ますか？」 before a lookup he had already asked for). The Claude text reply
 * (`CLAUDE_TEXT_LINES`) and the Claude voice reply (`CLAUDE_VOICE_LINES`) carry it; the historical GPT profile keeps its words.
 */
export const CONVERSATION_CONTINUITY_LINE = '[会話の続き] これまでの会話とこの返事に渡された文脈は、いつも頭に入っているものとして扱う。'
  + '続きの質問にはそのまま答え、「前の話を確認しますね」「考えを整理しますね」のような前置きをしない。'
  + 'ライ氏がこの会話ですでに言ったこと（いる場所・予定・時刻など）やボクが前に答えたことを使い、同じことを聞き直さない。'
  + '前の返事で言った時刻・数字・道順は保ち、変える時は変えたことと理由をひと言添える。'
  + '頼まれたことがはっきりしていて、この返事でできる読み取りや調べものなら、「〜しましょうか？」「見ますか？」と確かめずにする。';

/**
 * The Claude voice reply's length (owner feedback 2026-10-13, 「長くて聞いていられない」; live replies still ran 110–174 characters):
 * the historical profile's 「複雑な回答でも原則3文」 no longer stands beside the 1–2 sentence rule of `VOICE_NATURAL_INSTRUCTIONS`.
 * Also given to a voice turn answered through the structured text request (`spokenReply`). The historical GPT profile keeps
 * `VOICE_REPLY_INSTRUCTIONS`.
 */
export const SHORT_VOICE_REPLY_INSTRUCTIONS = '[音声専用の返答]\n自然な日本語の話し言葉で、最初に答えを置く。' + COMPUTED_ANSWER_LINE
  + 'ふだんは1〜2文の短い文（全体でおよそ60字）にし、複雑な内容でも要点だけを言う。'
  + '言い切れない続きがある時だけ、要点のあとに続きを話そうかと聞くか、詳しくは画面に出すと短く添える。'
  + '相手が長い話・物語・長めのセリフや詳しい説明をはっきり求めたときだけ、求められた長さで最後まで話してよい。'
  + 'Markdown、URL一覧、内部処理の説明、JSONは使わない。聞き取りやすい短い文にし、必要がなければ末尾に質問を足さない。';

/** A voice turn's reply written through the structured text request is still spoken (`spokenReply`). */
export const SPOKEN_STRUCTURED_REPLY_LINE = '[声で話す返事] この返事のreplyはそのまま声で読み上げる。表・箇条書き・Markdown・URLは使わない。';

/**
 * How a text reply is shown in the app (rich chat, owner decision 2026-10-13, Syzygy ADR-0009 §10): the form follows the content,
 * chosen by her. The current Claude text request only; a voice reply and the historical GPT profile keep their words.
 * The app renders exactly these blocks (`ShannonMessageMarkdown`): pipe tables, ```chart JSON, https images, numbered lists.
 */
export const RICH_TEXT_BLOCK_INSTRUCTIONS = [
  '[画面での見せ方]',
  '返答はアプリのチャットに表示される。内容に合う形をボクが選ぶ。短い会話や気持ちのやり取りには使わない。',
  '- 2つ以上のものをいくつかの観点で比べる時は、Markdownの表（| 見出し | … | の行と |---| の区切り行）。列は2〜5、行は12まで。',
  '- 数の推移や大小を見せる時は ```chart のコードブロックにJSONを1つ: {"type":"bar"または"line","title":"…","x":["…"],"series":[{"name":"…","values":[数…]}]}。'
    + 'xは24個まで、seriesは4本まで。分かっている数だけを使い、作らない。',
  '- 手順は番号つきリスト（1. 2. 3.）。',
  '- 場所は地図のカードで出るので、住所の表にはしない。',
  '- 画像は、調べた資料に実際にあった https の画像アドレスがある時だけ ![説明](https://…) で1〜2枚。アドレスを作らない。',
].join('\n');

/**
 * How a spoken reply stays a conversation (owner feedback 2026-10-13, 「自然な会話になっていない」, then 「長くて聞いていられない」):
 * a short spoken turn, no status boilerplate, no habitual disclaimer, a reaction answered as a reaction. The current Claude
 * voice request only; the historical GPT profile keeps its words.
 */
export const VOICE_NATURAL_INSTRUCTIONS = '[音声の自然さ]\n'
  + '声の返事は、複雑な内容でも1〜2文の短いひと言で要点だけを言う。ライ氏が詳しく話してと頼んだ時だけ長く話す。'
  + '内容が本当に長くて声では言い切れない時だけ、要点のあとに「詳しくは画面に出しておくね」と添える。短く言える時は添えない。'
  + '「受け付けました」「結果がそろいました」「少しお待ちください」のような状況報告の決まり文句や、検索結果の抜粋だという毎回の断り書きは言わない。'
  + '不確かさは答えが変わる時だけ短く添える。相づちや感想には、それ自体に応える。';
