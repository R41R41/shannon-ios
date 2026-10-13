/** The fixed instructions of a reply, by channel (Syzygy ADR-0008 stage 3, S3: the voice reply's, moved unchanged out of the chat model adapter into the respond action; every adapter sends the same words). */


export const VOICE_REPLY_INSTRUCTIONS = '[音声専用の返答]\n自然な日本語の話し言葉で、最初に答えを置く。挨拶と通常会話は1〜2文、複雑な回答でも原則3文に収める。ただし相手が長い話・物語・長めのセリフなどをはっきり求めたときは、求められた長さで最後まで話してよい。Markdown、URL一覧、内部処理の説明、JSONは使わない。聞き取りやすい短い文にし、必要がなければ末尾に質問を足さない。';

/**
 * The Claude voice reply's length (owner feedback 2026-10-13, 「長くて聞いていられない」; live replies still ran 110–174 characters):
 * the historical profile's 「複雑な回答でも原則3文」 no longer stands beside the 1–2 sentence rule of `VOICE_NATURAL_INSTRUCTIONS`.
 * Also given to a voice turn answered through the structured text request (`spokenReply`). The historical GPT profile keeps
 * `VOICE_REPLY_INSTRUCTIONS`.
 */
export const SHORT_VOICE_REPLY_INSTRUCTIONS = '[音声専用の返答]\n自然な日本語の話し言葉で、最初に答えを置く。'
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
