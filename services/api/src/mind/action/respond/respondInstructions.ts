/** The fixed instructions of a reply, by channel (Syzygy ADR-0008 stage 3, S3: the voice reply's, moved unchanged out of the chat model adapter into the respond action; every adapter sends the same words). */


export const VOICE_REPLY_INSTRUCTIONS = '[音声専用の返答]\n自然な日本語の話し言葉で、最初に答えを置く。挨拶と通常会話は1〜2文、複雑な回答でも原則3文に収める。ただし相手が長い話・物語・長めのセリフなどをはっきり求めたときは、求められた長さで最後まで話してよい。Markdown、URL一覧、内部処理の説明、JSONは使わない。聞き取りやすい短い文にし、必要がなければ末尾に質問を足さない。';

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
