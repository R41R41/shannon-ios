/**
 * The cap of the mode's always-on instructions (system[1]) by `llmcTokens`.
 * - Until 11/11 the text was Japanese: 9,200 llmc tokens, about 7.5k real tokens (the counter's 0.82), inside the 8k of D3.
 * - 11/11 (owner: the instructions are written in English, the model's outputs stay Japanese): `llmcTokens` weighs an English letter at 0.48 and a space at
 *   0.43, a calibration for identifiers and JSON; English prose is about 0.25 real tokens a character, so the counter reads the English text about twice its
 *   real size (the English text: 9,9xx llmc, an estimated 5.2k real tokens against the Japanese 8,554 llmc, about 7.0k real). The cap is the measured size
 *   of the English text with a few percent of room, so it still stops the text from growing; the real size is measured with the API's counter.
 * - 11/13 (review of the run-8 fixes): the urgent rules say a lone skeleton the urgent line says 「詰めて斬れる」 is fought first (about 20 llmc, about 12
 *   real; the urgent decision otherwise reads only 「離れる・間に置く」 against the line); the text measures 10,306, the cap is 10,320.
 * - 11/22 (four runs of a cake asked with bone meal, bn1 to bn4): one line says the descent's preparation (food, stone tools) and the yardstick are for the whole game and not
 *   for a one-thing request (about 180 llmc, about 50 real). It has to be in this text: the request's steps are in the stage knowledge, which yields to this text where they
 *   disagree, and they are given only to a request. The text measures 10,486, the cap is 10,500.
 * - 11/24 (the night deaths of 11/23): the scope line says a request to fight enemies needs gear first (the stage text carries the rest, the urgent rules point to it; about 50 llmc,
 *   about 20 real). The text measures 10,538, the cap is 10,550.
 */
export const ALWAYS_TEXT_CAP_LLMC = 10_550;
