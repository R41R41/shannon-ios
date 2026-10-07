/** The fixed instructions of a reply, by channel (Syzygy ADR-0008 stage 3, S3: the voice reply's, moved unchanged out of the chat model adapter into the respond action; every adapter sends the same words). */


export const VOICE_REPLY_INSTRUCTIONS = '[音声専用の返答]\n自然な日本語の話し言葉で、最初に答えを置く。挨拶と通常会話は1〜2文、複雑な回答でも原則3文に収める。ただし相手が長い話・物語・長めのセリフなどをはっきり求めたときは、求められた長さで最後まで話してよい。Markdown、URL一覧、内部処理の説明、JSONは使わない。聞き取りやすい短い文にし、必要がなければ末尾に質問を足さない。';
