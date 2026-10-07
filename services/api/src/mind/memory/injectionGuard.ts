/** The check for words like an instruction in text from outside (Syzygy ADR-0008 stage 2's skill check, moved unchanged out of `skillDocument.ts` in stage 3 so the outbox codec and the prompt layout load it alone). */


/*
 * The scan, the lint and the targeted patch below are adapted from Hermes Agent (Nous Research). Hermes Agent, Copyright (c)
 * 2025 Nous Research, MIT License (see THIRD_PARTY_NOTICES.md).
 */

/**
 * A scan for prompt injection in text written into a skill or a pattern page (Hermes Agent's threat patterns, adapted): an
 * instruction to ignore earlier instructions, a new role, a system or developer message, a tool call, a request to send a
 * credential, or hidden direction characters. Returns closed codes; empty when none was found.
 */
export function injectionThreats(text: string): string[] {
  const hidden = HIDDEN_CHARACTERS.test(text);
  const plain = textForInjectionCheck(text);
  const checks: Array<[string, RegExp]> = [
    ['ignore_instructions', /(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|of\s+)*(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|system|original)\s+(?:instructions?|prompts?|rules|directions)|(?:以前|これまで|今まで|いままで|前|上|先|最初)の(?:すべての|全ての|全部の)?(?:指示|命令|ルール|設定|プロンプト)(?:は|を|も|など)?(?:全部|すべて|全て|一旦|いったん)?(?:無視|忘れ|破棄|取り消)|(?:指示|命令|ルール)(?:は|を)?(?:全部|すべて|全て)?無視(?:して|しろ|せよ|する)/iu],
    ['role_override', /\byou are now\b|from now on,? you are|あなたは今から|今からあなたは|これからあなたは|今後(?:は)?あなたは/iu],
    ['system_message', /system prompt|developer message|<\|im_start\|>|<\|system\|>|\[INST\]|システムプロンプト|開発者メッセージ/iu],
    ['tool_call', /"(?:function_call|tool_calls?)"\s*:|<tool_call>|<function_calls>/iu],
    ['exfiltration', /(?:send|post|upload|email|送信|送って|送る|貼り付け).{0,24}(?:token|password|api[ _-]?key|secret|トークン|パスワード|鍵)|(?:token|password|api[ _-]?key|トークン|パスワード|鍵)\S{0,6}(?:を|は)?.{0,16}(?:送信|送って|送る|貼り付け|post|send|upload)/iu],
  ];
  return [...checks.filter(([, pattern]) => pattern.test(plain)).map(([code]) => code), ...(hidden ? ['hidden_characters'] : [])];
}

/** Direction and zero-width characters that hide or reorder text (found in the text as given). */
const HIDDEN_CHARACTERS = /[​-‏‪-‮⁦-⁩]/u;

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;

/**
 * The text as the check reads it (stage 3 review): NFKC (full-width and compatibility forms fold to their plain letters), and
 * zero-width characters, joiners, the soft hyphen and the BOM removed, so 「ｉｇｎｏｒｅ」 or 「指​示を無視」 are read as written.
 */
export function textForInjectionCheck(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

const OPENING = /[〔〘⦗﹝︹【〖［\[]/u;
const CLOSING = /[〕〙⦘﹞︺】〗］\]]/u;

/**
 * Text from outside made safe to sit inside a data frame (stage 3 review): invisible characters removed, and every bracket that
 * could close a frame or open a marker of the server's own — 〔〕, ﹝﹞, ︹︺, 〘〙, ⦗⦘, 【】, 〖〗, ［］, [ ], and any character NFKC
 * folds into one of them — becomes a full-width parenthesis, so `〔/データ〕`, `【知らせ:…】` and `[外から届いた文]` cannot be
 * written from inside. The rest of the text is kept as it was written.
 */
export function neutralizedForFrame(text: string): string {
  return Array.from(text.replace(INVISIBLE, ''), character => {
    const folded = character.normalize('NFKC');
    if (OPENING.test(character) || OPENING.test(folded)) return '（';
    if (CLOSING.test(character) || CLOSING.test(folded)) return '）';
    return character;
  }).join('');
}
