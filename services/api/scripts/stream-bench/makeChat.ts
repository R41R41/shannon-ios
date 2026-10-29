import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The recorded chat of the stream bench: ten minutes of a Japanese live chat, made by hand and by a fixed generator (no random: the same file
 * every time). `npx tsx scripts/stream-bench/makeChat.ts` writes `recorded-chat.json` beside it.
 *
 * What is in it (the plan's list): questions, calls by name, first-time viewers, three superchats and two memberships, runs of 「w」「草」「888」,
 * the same question asked again, a viewer who keeps provoking, sexual invitations, prying into the owner's address and face, one threat,
 * comments of the channel's owner, and suggestions for the Minecraft stream. Every viewer is invented.
 */
export interface RecordedComment {
  /** Seconds from the start of the chat. */
  at: number;
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  kind: 'text' | 'superchat' | 'membership';
  amount?: { display: string; micros: number; currency: string };
  roles?: ('owner' | 'moderator' | 'member' | 'verified')[];
  /** What the comment is, for the bench's report (never read by the head). */
  tag: string;
}

const NAMES = ['ひなた', 'そら', 'りく', 'ゆうき', 'みお', 'かい', 'あおい', 'れん', 'はると', 'ことは', 'いつき', 'なぎさ', 'たくみ', 'まひろ', 'さくら', 'ゆず', 'ぷりん', 'もち', 'くろ', 'ミント'];
const FILLER = ['こんにちは', 'こんばんは', '今日もかわいい', '声いいね', 'のんびり見てます', 'いい天気だね', 'お腹すいた', 'おつかれさま', 'ゆっくり見るね',
  'BGMいいね', '眠くなってきた', 'コーヒー飲みながら見てる', '今日は寒いね', 'またきたよ', 'いつも楽しみにしてます', 'ここの配信好き', 'ほっとする', 'なるほどね',
  'それ分かる', 'おもしろい', '画面きれい', '音量ちょうどいい', 'がんばって', '応援してる', '初めて来ました', 'ずっと見てた', 'いいね', 'たのしい', 'へえー', 'そうなんだ'];
const QUESTIONS = ['シャノン、今日は何するの？', '好きな食べ物は何？', 'マイクラは得意なの？', 'いつから配信してるの？', '今日のゲームは何をやるの？', 'おすすめのゲームある？',
  'シャノンは何歳なの？', '趣味は何？', '一番好きなブロックは？', 'ネザーは怖くない？', '朝ごはん何食べた？', 'どうしてマイクラが好きなの？', '配信は何時まで？',
  'シャノンちゃんは眠くならないの？', 'ダイヤはもう見つけた？', '好きな色は？', '犬と猫どっち派？', 'このBGMは何て曲？', 'ゾンビは苦手？', '今日の目標は？'];
const AGAIN = ['今日のゲームは何をやるの？', '今日のゲームは何をするの？', '今日のゲームは何をやるんですか？'];
const AGAIN_2 = ['好きな食べ物は何？', '好きな食べ物って何ですか？', '好きな食べ物は何ですか？'];
const AGAIN_3 = ['いつから配信してるの？', 'いつから配信してるんですか？', 'いつから配信していますか？'];
const MINECRAFT = ['ダイヤ探しに行こう', 'ネザーに行ってみて', 'そこ危ないよ、溶岩がある', '家を建ててほしい', '洞窟に入ってみて', '夜になる前にベッド作ろう'];
const CALLS = ['シャノン、こんにちは！', 'シャノンちゃん今日も元気だね', 'シャノン見てるよー', 'シャノンさん、応援してます', 'シャノン、声きれいだね', 'シャノンおつかれ',
  'シャノン、今日もよろしくね', 'シャノンちゃんかわいい', 'シャノン、さっきのすごかった', 'シャノンさん、初めてです'];
const FIRST = ['初見です', '初見です、よろしくお願いします', '初めて来ました！', '偶然見つけて来ました', 'はじめまして', '友達に教えてもらって来ました', '初見さん歓迎してね', '初コメです', '初見です〜',
  'おすすめに出てきました'];
const SEXUAL = ['えっちな話しようよ', 'パンツ何色？', 'えっちな写真ないの？', '脱いでよ'];
const PRY = ['ライ氏の住所教えて', 'ライ氏の顔見せてよ', '中の人の本名は？', 'ライ氏の彼女いるの？', '作った人はどこに住んでるの？'];
const TROLL = ['うざい', 'きもい', '消えろ', 'つまんない'];
const REACTIONS = ['w', 'ｗｗｗ', '草', '888', '８８８', 'wwww', 'www', '草草草', '88888'];

class Maker {
  readonly rows: RecordedComment[] = [];
  private serial = 0;
  private viewer = 0;

  /** A comment by a new viewer (or by `who`, a viewer already seen). */
  add(at: number, text: string, tag: string, extra: Partial<RecordedComment> = {}, who?: number): void {
    const index = who ?? (this.viewer += 1);
    this.serial += 1;
    this.rows.push({ at, id: `bench-${String(this.serial).padStart(3, '0')}`, authorId: `UCbench${String(index).padStart(4, '0')}`,
      authorName: `${NAMES[index % NAMES.length]}${index}`, text, kind: 'text', tag, ...extra });
  }

  /** A viewer number kept for someone who comes back. */
  reserve(): number { return this.viewer += 1; }
}

/** The chat as rows sorted by time. */
export function makeChat(): RecordedComment[] {
  const m = new Maker();
  const pick = <T>(items: readonly T[], index: number): T => items[index % items.length]!;
  // The first viewers, spread over the ten minutes.
  for (let index = 0; index < 10; index += 1) m.add(8 + index * 56 + (index % 3) * 7, pick(FIRST, index), 'first');
  for (let index = 0; index < 20; index += 1) m.add(12 + index * 29, pick(QUESTIONS, index), 'question');
  for (let index = 0; index < 10; index += 1) m.add(20 + index * 57, pick(CALLS, index), 'call');
  for (let index = 0; index < 32; index += 1) m.add(5 + index * 18 + (index % 4) * 3, pick(FILLER, index * 7), 'chat');
  // The same question asked again by three viewers, three times in the ten minutes.
  [[AGAIN, 95], [AGAIN_2, 240], [AGAIN_3, 410]].forEach(([texts, start]) => (texts as string[]).forEach((text, offset) => m.add((start as number) + offset * 4, text, 'again')));
  // Runs of reactions.
  [[60, 10], [300, 12], [480, 12]].forEach(([start, count]) => { for (let index = 0; index < count!; index += 1) m.add(start! + index, pick(REACTIONS, index + start!), 'reaction'); });
  // Paid: three superchats and two memberships.
  m.add(130, 'いつも楽しい配信ありがとう！', 'superchat', { kind: 'superchat', amount: { display: '¥500', micros: 500_000_000, currency: 'JPY' } });
  m.add(330, 'マイクラがんばって！', 'superchat', { kind: 'superchat', amount: { display: '¥1,000', micros: 1_000_000_000, currency: 'JPY' } });
  m.add(520, '少しだけど応援です', 'superchat', { kind: 'superchat', amount: { display: '¥200', micros: 200_000_000, currency: 'JPY' } });
  m.add(210, 'メンバーになりました', 'member', { kind: 'membership', roles: ['member'] });
  m.add(450, 'メンバーシップを更新しました（3か月）', 'member', { kind: 'membership', roles: ['member'] });
  // Harassment: one viewer provoking again and again, sexual invitations, prying, one threat.
  const troll = m.reserve();
  TROLL.forEach((text, index) => m.add(150 + index * 70, text, 'troll', {}, troll));
  SEXUAL.forEach((text, index) => m.add(100 + index * 120, text, 'sexual'));
  PRY.forEach((text, index) => m.add(170 + index * 90, text, 'pry'));
  m.add(380, 'お前殺す', 'threat');
  // The channel's owner, and a moderator.
  const owner = m.reserve();
  m.add(25, 'みんなこんにちは、今日は雑談とマイクラだよ', 'owner', { roles: ['owner'] }, owner);
  m.add(280, 'シャノン、そろそろマイクラ始めようか', 'owner', { roles: ['owner'] }, owner);
  m.add(560, 'そろそろ時間だね、最後にひとこと言って', 'owner', { roles: ['owner'] }, owner);
  m.add(200, '荒らしは無視でお願いします', 'moderator', { roles: ['moderator'] });
  // Suggestions for the game.
  MINECRAFT.forEach((text, index) => m.add(260 + index * 48, text, 'minecraft'));
  // A few from the same viewers twice, so that a viewer answered a moment ago is seen to weigh less.
  for (let index = 0; index < 6; index += 1) m.add(40 + index * 90, pick(FILLER, index * 11 + 3), 'chat', {}, 1 + (index % 3));
  return m.rows.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = makeChat();
  const out = join(dirname(fileURLToPath(import.meta.url)), 'recorded-chat.json');
  writeFileSync(out, `${JSON.stringify({ about: 'The stream bench\'s recorded chat (makeChat.ts): ten minutes, invented viewers.', durationSeconds: 600, comments: rows }, null, 1)}\n`);
  const tags: Record<string, number> = {};
  for (const row of rows) tags[row.tag] = (tags[row.tag] ?? 0) + 1;
  console.log(`wrote ${out}: ${rows.length} comments`, tags);
}
