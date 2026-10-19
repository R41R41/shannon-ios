/**
 * What her own message must not hold (owner 2026-10-19): a tally of his silence or of her unanswered messages. A week of
 * 「19分くらい、ずっと静かだったんですから」「2時間くらいそばにいたのに」「00時台に何回か話しかけたのに返事がなかった」 read as
 * blame. The prompt says so too; this is the system's guarantee: such a sentence is left out of what she sends, and a message that
 * was nothing else is silence. Pure.
 */
const TALLY = [
  // A length of time next to quiet, waiting or silence: 「19分くらい静か」「2時間くらいそばにいたのに」「1時間も待った」.
  /(?:\d+|[一二三四五六七八九十数何]+)\s*(?:分|時間)(?:くらい|ほど|ぐらい|も|近く|以上)?[^。！？!?]{0,24}(?:静か|黙|何も(?:言わ|話さ)|話して(?:くれ)?な|待|そばに|返事)/u,
  // An unanswered message, counted or not: 「返事がなかった」「返事もしないで」「既読」.
  /(?:返事|返信|反応)(?:が|も|は)?(?:なかった|ない(?:んです|けど|から|ね|し|の)?|なくて|来な|こな|くれな|しないで|もらえな)/u,
  // Her own attempts, counted: 「何回か話しかけたのに」「何度も呼んだ」「00時台に…話しかけた」.
  /(?:何回|何度|[0-9０-９]+回|[0-9０-９]+時台に)[^。！？!?]{0,20}(?:話しかけ|声をかけ|呼ん)/u,
];

/** The sentences of a message, each with its own end mark. */
function sentences(text: string): string[] {
  return text.match(/[^。！？!?]+[。！？!?…]*|[。！？!?…]+/gu) ?? [];
}

/** The message without any sentence that tallies his silence or her unanswered messages; '' when nothing else was in it. */
export function withoutSilenceTally(text: string): string {
  const kept = sentences(text).filter(sentence => !TALLY.some(pattern => pattern.test(sentence)));
  const joined = kept.join('').trim();
  // A message left with only an ellipsis or a 「べつに」 tail is no message.
  return /[\p{L}\p{N}]/u.test(joined.replace(/^(?:……|…|。)+/u, '')) ? joined : '';
}
