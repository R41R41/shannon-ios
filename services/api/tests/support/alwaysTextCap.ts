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
 * - 11/24 (try1124b, the owner's test of 07:12: a zombie in a pool, 22 urgent decisions each chose a move of 1 to 4 blocks and 15 of 38 acts were replaced before they arrived): the urgent rules say a move away
 *   is one go or walk of 10 blocks or more (about 60 llmc, about 25 real). The text measures 10,599, the cap is 10,610.
 * - 11/26 (11/15c n, ported onto the 11/24 text: health 6.7 at fullness 17 with no food waited 1,600 s, the gate back 196 m off, held by 「do not travel far while lacking food」 and
 *   「eat, wait to recover」): the health rule says waiting brings nothing back below fullness 18 and allows the far trip for food, and the safety rule waits only at fullness 18 or more
 *   (about 29 llmc, about 15 real). The text measures 10,633, the cap is 10,650.
 * - 11/26 (the end-dragon run on Haiku: 316 acts of one hand, the body idle about 3 tenths of the time): the deciding rule says to stack the known follow-up hands in one act and why
 *   (it replaces the older line's first sentence; about 23 llmc, about 11 real). The text measures 10,673, the cap is 10,690.
 * - 11/26 (the end-dragon run, the 4th: three or four hoglins killed her from 20 in about 13 s; the urgent decision had been told to put attack untilDead first): the urgent rules say to count
 *   the fight (hits = health / damage per hit, about 0.6 s a hit, the enemies near keep hitting) before putting the attack first, and the route line says a stand on the enemy's side is no retreat
 *   (about 115 llmc, about 45 real). The text measures 10,788, the cap is 10,800.
 * - 11/26 (the end-dragon run, the 6th: caught fire beside lava, ate while burning from 4.1 to 2.1 and burned to death; the urgent rules had no word of fire): one short urgent rule says a
 *   burning body loses 1 health a second and the Nether's water does not put it out (about 40 llmc). The text measures 10,828, the cap is 10,830.
<<<<<<< HEAD
 * - 11/27 (the 9th end-dragon run: 70 hands of the End's preparation and none of the stronghold, with the stronghold first in the plan): the priority line says the End's check may wait until behind the
 *   stronghold, the plan rules say the End's shortage does not count as moving deeper while the current node is the stronghold, and one rule says the stronghold's hands go first with the three cases that
 *   allow another node's hand (about 330 llmc). The text measures 11,163, the cap is 11,180.
 */
export const ALWAYS_TEXT_CAP_LLMC = 11_180;
=======
 * - 11/27 (the 9th end-dragon run: the diamond pickaxe went 73 to 10 of 1561 while digging, and its 「1/3 を切っている」 was read as a tool to remake, dropped twice): the death rule's
 *   English durability clause says a short diamond pickaxe is kept for obsidian, not remade (about 29 llmc). The text measures 10,859, the cap is 10,860.
 */
export const ALWAYS_TEXT_CAP_LLMC = 10_860;
>>>>>>> claude/endra-tools-1127c
