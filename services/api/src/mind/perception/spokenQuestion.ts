/**
 * Whether words she said end by asking something of the room (「どこに置けばいい？」 「渡せばいいかな」). Read from her own line, not from anyone's
 * reply to it: a question she asked waits for an answer for longer than an ordinary follow-up does (`addressed.ts`, `askedHer`). The last two
 * sentences count, since she may add a short word after the question (「どこに置く？ここで待ってるね」).
 */
const AFTER_SENTENCE_END = /(?<=[。！!？?])/u;
const TRAILING_MARKS = /[\s」』）)\]"'”’…〜~ー♪♡☆★]+$/u;
const QUESTION_MARK = /[？?]$/u;
const SPOKEN_QUESTION = /(?:か|かな|かなあ|かなぁ|かね|かい|でしょうか|だろうか)[。.]?$/u;

export function endsAsQuestion(text: string): boolean {
  return text.split(AFTER_SENTENCE_END).map(part => part.replace(TRAILING_MARKS, '').trim()).filter(Boolean).slice(-2)
    .some(sentence => QUESTION_MARK.test(sentence) || SPOKEN_QUESTION.test(sentence));
}

/**
 * Only a mark ends the question (「鉄が必要か？」), not a spoken ending (「鉄が必要か」). For the words she says by herself: a thought said aloud that
 * ends 「…か」 is no question to the room, and must not open the way for the next nameless words.
 */
export function endsWithQuestionMark(text: string): boolean {
  return text.split(AFTER_SENTENCE_END).map(part => part.replace(TRAILING_MARKS, '').trim()).filter(Boolean).slice(-2).some(sentence => QUESTION_MARK.test(sentence));
}
