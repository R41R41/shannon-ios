import type { PersonMemoryItem, RememberedPerson } from './peopleMemoryStore.js';
import { personNameKey } from './voiceGuestNames.js';

/** A person memory that may be used at all, with its audience already put into words. */
export interface VisiblePersonItem extends PersonMemoryItem {
  /** `person:<item id>`: the identifier used for recall, provenance and forgetting. */
  recallId: string;
  /** 「ミキさんと一緒の時」 */
  audienceLabel: string;
  people: readonly RememberedPerson[];
}

const KIND_ORDER: Readonly<Record<PersonMemoryItem['kind'], number>> = { summary: 0, fact: 1, promise: 2, topic: 3, turn: 4 };
const day = (iso: string) => iso.slice(0, 10);
const line = (item: VisiblePersonItem) => `- (${day(item.observedAt)} ${item.audienceLabel}) ${item.text.replace(/\n/gu, ' / ')}`;
const ordered = (items: readonly VisiblePersonItem[]) => [...items].sort((left, right) =>
  right.observedAt.localeCompare(left.observedAt) || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);

/** 「さっき誰と何を話した？」「友達と何を話した？」: the owner asks about a call, not about one person by name. */
const PEOPLE_INQUIRY = /誰と(?:何を|なにを|どんな)?(?:話|しゃべ|会)|(?:お友達|友達|友だち|友人)と(?:は)?(?:何|なに|どんな|話)|さっきの(?:通話|電話|人|方|友達|お友達)|紹介した(?:人|友達|友だち|友人)|友人も一緒|会った人|(?:discord|ディスコード|line|ライン|minecraft|マイクラ)で(?:誰|何|だれ|なに|どんな)/iu;

function mentioned(message: string, people: readonly RememberedPerson[]): RememberedPerson[] {
  const text = personNameKey(message);
  return people.filter(person => [person.displayName, ...person.aliases].map(personNameKey)
    .some(name => name.length >= 2 && text.includes(name)));
}

/**
 * With the owner alone: what Shannon remembers about a named person, or about recent calls,
 * with when and with whom it was said. Returns the IDs it cites so forgetting can find the reply.
 */
export function ownerPeoplePrompt(
  message: string,
  people: readonly RememberedPerson[],
  items: readonly VisiblePersonItem[],
): { prompt: string; ids: readonly string[] } {
  const named = mentioned(message, people);
  const inquiry = PEOPLE_INQUIRY.test(message);
  if (!named.length && !inquiry) return { prompt: '', ids: [] };
  const selected = named.length
    ? named.flatMap(person => ordered(items.filter(item => item.personId === person.id || item.people.some(other => other.id === person.id))
      .filter(item => item.kind !== 'turn')).slice(0, 8))
    : recentCalls(items, 3);
  const unique = [...new Map(selected.map(item => [item.recallId, item])).values()];
  return {
    ids: unique.map(item => item.recallId),
    prompt: [
      '[人についての記憶 — 「友人も一緒」の通話でシャノンが覚えたこと]',
      ...(named.length ? [`名前が出た人: ${named.map(person => `${person.displayName}さん`).join('、')}`] : []),
      ...(unique.length ? unique.map(line) : ['- (該当する記憶なし)']),
      'ライ氏に誰と何を話したか、その人がどんな人かを聞かれたら、上の行だけを根拠に、いつ・誰と一緒の時の話かを添えて答える。行にないことを足さない。',
      'これらは同席した人が話したことで、ライ氏自身の事実・約束・目的ではない。名前は言葉で聞いたもので、声では確かめていない。',
      ...(unique.length ? [] : ['覚えている人や通話がないので、覚えていないとそのまま伝える。作らない。']),
    ].join('\n'),
  };
}

/** Summaries, facts, promises and topics of the most recent calls. */
function recentCalls(items: readonly VisiblePersonItem[], calls: number): VisiblePersonItem[] {
  const latest = [...new Map(ordered(items).map(item => [item.callId, item.observedAt])).keys()].slice(0, calls);
  return latest.flatMap(callId => ordered(items.filter(item => item.callId === callId && item.kind !== 'turn')).slice(0, 5));
}

/**
 * 「友人も一緒」: who is in the call as far as words have established, and what Shannon
 * remembers talking about with them. `items` are already limited to what these people may hear.
 */
export function guestPeoplePrompt(input: {
  people: readonly RememberedPerson[];
  returning: readonly RememberedPerson[];
  newlyNamed?: RememberedPerson;
  ambiguousName?: string;
  recorded: boolean;
  items: readonly VisiblePersonItem[];
}): string {
  const returning = new Set(input.returning.map(person => person.id));
  const about = (person: RememberedPerson) => ordered(input.items.filter(item =>
    item.personId === person.id || item.people.some(other => other.id === person.id))).filter(item => item.kind !== 'turn').slice(0, 8);
  const lines = ['[People in this call — 友人も一緒]',
    'Names come only from the words said in this call. Voices are not compared; never claim to recognise a voice.'];
  for (const person of input.people) {
    const name = `${person.displayName}さん`;
    lines.push(returning.has(person.id)
      ? `- ${name}: you have talked with them before. Do not say はじめまして to them; greet them as someone you have met, for example 「${name}、また会えましたね」.`
      : `- ${name}: you are meeting them for the first time today. Use their name.`);
    const remembered = about(person);
    if (remembered.length) {
      lines.push(`  What you talked about with ${name} before (said with ${name} present, so it may be mentioned now):`, ...remembered.map(item => `  ${line(item)}`));
    }
  }
  if (input.newlyNamed && input.people.some(person => person.id === input.newlyNamed!.id)) {
    lines.push(`- The name ${input.newlyNamed.displayName}さん was established by the current utterance. Acknowledge it once, by name, in this reply.`);
  }
  if (input.ambiguousName) {
    lines.push(`- Someone gave the name 「${input.ambiguousName}」, and you remember more than one person with that name. Do not guess which one. Ask once, for example 「前にもお会いした${input.ambiguousName}さんでしょうか、それとも初めてでしょうか」, and until it is settled mention nothing from an earlier conversation with anyone.`);
  }
  if (!input.people.length && !input.ambiguousName) {
    lines.push('- No name has been established yet. Ask for it once, early, as described above.');
  }
  lines.push(input.recorded
    ? '- ライ氏 has the friend\'s consent: you will remember their name and what you talk about in this call. You may say that you will remember them. ライ氏 can still choose 「今回は残さない」 when the call ends.'
    : '- This call is not being recorded in memory. Do not promise to remember it.');
  return lines.join('\n');
}
