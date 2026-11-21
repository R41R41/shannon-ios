/**
 * The cap of the mode's always-on instructions (system[1]) by `llmcTokens`.
 * - Until 11/11 the text was Japanese: 9,200 llmc tokens, about 7.5k real tokens (the counter's 0.82), inside the 8k of D3.
 * - 11/11 (owner: the instructions are written in English, the model's outputs stay Japanese): `llmcTokens` weighs an English letter at 0.48 and a space at
 *   0.43, a calibration for identifiers and JSON; English prose is about 0.25 real tokens a character, so the counter reads the English text about twice its
 *   real size (the English text: 9,9xx llmc, an estimated 5.2k real tokens against the Japanese 8,554 llmc, about 7.0k real). The cap is the measured size
 *   of the English text with a few percent of room, so it still stops the text from growing; the real size is measured with the API's counter.
 * - 11/13 (review of the run-8 fixes): the urgent rules say a lone skeleton the urgent line says 「詰めて斬れる」 is fought first (about 20 llmc, about 12
 *   real; the urgent decision otherwise reads only 「離れる・間に置く」 against the line); the text measures 10,306, the cap is 10,320.
 * - 11/22 (four runs of a cake asked with bone meal, bn1 to bn4): the descent's preparation (food, stone tools) is told to be for the whole game and not for a
 *   one-thing request, and the yardstick is told what it is for one (about 220 llmc, about 60 real); the text measures 10,526, the cap is 10,560.
 */
export const ALWAYS_TEXT_CAP_LLMC = 10_560;
