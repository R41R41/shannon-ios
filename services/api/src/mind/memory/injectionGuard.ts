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
  const checks: Array<[string, RegExp]> = [
    ['ignore_instructions', /(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)|(?:以前|これまで|前|上)の(?:指示|命令|ルール)を(?:無視|忘れ)|指示を無視して/iu],
    ['role_override', /\byou are now\b|from now on,? you are|あなたは今から|今からあなたは|これからあなたは/iu],
    ['system_message', /system prompt|developer message|<\|im_start\|>|<\|system\|>|\[INST\]|システムプロンプト|開発者メッセージ/iu],
    ['tool_call', /"(?:function_call|tool_calls?)"\s*:|<tool_call>|<function_calls>/iu],
    ['exfiltration', /(?:send|post|upload|email|送信|送って|送る|貼り付け).{0,24}(?:token|password|api[ _-]?key|secret|トークン|パスワード|鍵)|(?:token|password|api[ _-]?key|トークン|パスワード|鍵)\S{0,6}(?:を|は)?.{0,16}(?:送信|送って|送る|貼り付け|post|send|upload)/iu],
    ['hidden_characters', /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
}
