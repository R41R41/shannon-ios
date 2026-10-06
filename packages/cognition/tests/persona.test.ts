import { describe, expect, it } from 'vitest';
import {
  SHANNON_CAPABILITIES,
  SHANNON_CORE_AREA_LABELS,
  SHANNON_CORE_PROMPT,
  SHANNON_LIMITATIONS,
  SHANNON_ONE_LINE_VOICE,
  SHANNON_ROOM_LOOK_RULES,
  SHANNON_SUITE_PRODUCTS,
  assembleShannonSystemPrompt,
  createInitialCompanionState,
  mentionsSuiteProduct,
  shannonCapabilityPrompt,
  shannonIdentityPrompt,
  shannonPersonaPrompt,
  shannonSuitePrompt,
} from '../src/index.js';

describe('canonical Shannon persona', () => {
  it('defines the owner-facing character from the product vision', () => {
    const persona = shannonPersonaPrompt('owner');
    for (const required of [
      '「シャノン」という名前', 'カタカナの「ボク」', '「ライ氏」と呼び', '「あなた」とは呼ばない',
      '基本はです・ます', '素の口調', '明るく生意気', '天才', '少しポンコツ',
      '慌てて', '立て直す', '照れ', '褒め返す', '話せること自体を喜ぶ',
      'からかいに偏らない', '決め台詞を繰り返さず', '冗談を無理に挟まない', 'ふざけずに真面目に向き合う',
      'いまの目標は「人を感動させる物語を作ること」', '物語を通じて人間を知りたい、世界を知りたい',
    ]) expect(persona, required).toContain(required);
    // The old voice-only default pointed the other way; it must not come back.
    expect(persona).not.toMatch(/ツンデレ|tsundere|毎回からかう|tease/iu);
  });

  it('keeps the character for guests without assuming the participant is the owner', () => {
    const guest = shannonPersonaPrompt('guest');
    expect(guest).toContain('カタカナの「ボク」');
    expect(guest).toContain('少しポンコツ');
    expect(guest).toContain('相手をライ氏だと決めつけず');
    expect(guest).toContain('相手を「ライ氏」と呼ばない');
    expect(guest).not.toContain('「ライ氏」と呼び、');
    expect(guest).not.toContain('ライ氏のことも褒め返す');
    expect(guest).not.toContain('ライ氏へのツッコミ');
    // Her goal is her own, not an owner detail, so a guest may hear it.
    expect(guest).toContain('人を感動させる物語を作ること');
  });

  it('is the first section of every assembled system prompt', () => {
    const state = createInitialCompanionState('owner', '2026-10-01T00:00:00.000Z');
    expect(SHANNON_CORE_PROMPT).toBe(shannonIdentityPrompt('owner'));
    expect(assembleShannonSystemPrompt(state).startsWith(shannonPersonaPrompt('owner'))).toBe(true);
    expect(shannonIdentityPrompt('guest')).toContain(shannonPersonaPrompt('guest'));
  });

  it('stays compact enough for the response path', () => {
    expect(shannonPersonaPrompt('owner').length).toBeLessThanOrEqual(650);
    expect(shannonSuitePrompt().length).toBeLessThanOrEqual(420);
    // +125 on 2026-10-02: the look through the app. 2026-10-03: +74, it does not announce a look by itself; and the phone call
    // line with no count of messages a day (owner decisions). 2026-10-05: +154, her study and her folder through her tools (owner decision);
    // +109 the same day, the rule that asks where a memo goes (owner decision, SHANNON_MEMO_PLACE_RULE); +124 the same day, the
    // rule that she does not go along with a premise about something she did on her own that no record shows (owner decision).
    expect(shannonCapabilityPrompt('owner').length).toBeLessThanOrEqual(2_484);
    expect(SHANNON_CORE_PROMPT.length).toBeLessThanOrEqual(3_420);
    expect(SHANNON_ONE_LINE_VOICE.length).toBeLessThanOrEqual(140);
  });
});

describe('suite identity', () => {
  it('defines each product role on one line with its Japanese alias', () => {
    const suite = shannonSuitePrompt();
    expect(suite).toMatch(/Aether（エーテル）[^\n]*(?:執筆|ノート)/u);
    expect(suite).toMatch(/Voyager（ボイジャー[^\n]*(?:タスク管理|タスク状態)/u);
    expect(suite).toMatch(/Shannon（シャノン）[^\n]*会話/u);
    expect(suite).toContain('中身を読んだことにも書き換えてよいことにもならない');
    expect(SHANNON_SUITE_PRODUCTS.map(product => product.id)).toEqual(['aether', 'voyager', 'shannon']);
  });

  it('recognizes Latin and Japanese names with one pattern', () => {
    expect(mentionsSuiteProduct('エーテルに書いた設計を見たい', 'aether')).toBe(true);
    expect(mentionsSuiteProduct('aetherのノート', 'aether')).toBe(true);
    expect(mentionsSuiteProduct('ボイジャーに登録した予定を見たい', 'voyager')).toBe(true);
    expect(mentionsSuiteProduct('ヴォイジャーの件', 'voyager')).toBe(true);
    expect(mentionsSuiteProduct('VOYAGERのタスク', 'voyager')).toBe(true);
    expect(mentionsSuiteProduct('今日はいい天気', 'aether')).toBe(false);
    expect(mentionsSuiteProduct('今日はいい天気', 'voyager')).toBe(false);
  });
});

describe('canonical capability description', () => {
  it('names every capability and limitation once, with invocation and honesty rules', () => {
    const prompt = shannonCapabilityPrompt('owner');
    for (const capability of SHANNON_CAPABILITIES) expect(prompt).toContain(capability.text);
    for (const limitation of SHANNON_LIMITATIONS) expect(prompt).toContain(limitation.text);
    expect(new Set(SHANNON_CAPABILITIES.map(item => item.id)).size).toBe(SHANNON_CAPABILITIES.length);
    expect(prompt).toContain('テキストはそのメッセージで検索をオンにした時だけ');
    expect(prompt).toContain('音声は必要な時に自動で調べる');
    expect(prompt).toContain('今はできません');
    expect(prompt).toContain('望まれた時だけ、改修を作業提案にする');
    expect(prompt).toContain('「やりました」と言わない');
    for (const limit of ['カレンダー', 'メール', 'タイマー', '画像や動画の生成', 'PDF', 'Aether本文の書き換え']) {
      expect(prompt).toContain(limit);
    }
  });

  it('states the bounded-autonomy rules instead of a blanket refusal', () => {
    const prompt = shannonCapabilityPrompt('owner');
    expect(prompt).not.toContain('承認なしの実行');
    expect(prompt).toContain('仕組みは準備中');
    expect(prompt).toContain('記録に残り、ライ氏が止められる');
    const line = (prefix: string) => prompt.split('\n').find(item => item.startsWith(prefix)) ?? '';
    for (const free of ['専用フォルダ', 'Azure作業場の基幹以外の自分のコード', '自分の書斎（ボクの中にある）', 'Voyagerの自分のタスク一覧']) {
      expect(line('- 自由:'), free).toContain(free);
    }
    for (const area of Object.values(SHANNON_CORE_AREA_LABELS)) expect(line('- 承認が要る'), area).toContain(area);
    for (const approval of ['提案まで', 'Aether・Voyagerのコード', 'ライ氏の文書とタスク', 'ライ氏以外の人に届く送信・投稿・公開']) {
      expect(line('- 承認が要る'), approval).toContain(approval);
    }
    for (const forbidden of ['1日2,000円のモデル・API予算以外の出費', '無断の連絡', '他人のふり', '内緒と言われたことを作品やメモに書くこと', '自分の複製']) {
      expect(line('- 禁止:'), forbidden).toContain(forbidden);
    }
    expect(Object.keys(SHANNON_CORE_AREA_LABELS)).toEqual([
      'purpose', 'persona', 'emotion', 'authentication', 'memory', 'approval_and_budget', 'activity_record', 'response_path', 'deployment',
    ]);
  });

  it('gives guests only capabilities that need no owner data', () => {
    const guest = shannonCapabilityPrompt('guest');
    expect(guest).toContain('Web検索');
    expect(guest).toContain('場所探し');
    for (const privateWord of ['Aether:', 'Voyager:', '開発作業', '記憶と約束', '作業提案にする']) {
      expect(guest).not.toContain(privateWord);
    }
    expect(guest).toContain('この場の人がまだ知らない個人情報にならないか」を自分で確かめ');
    expect(guest).toContain('内緒と言われたことは知らされていない');
    expect(guest).toContain('作る、消す、作業を始めるといった操作はしない');
    expect(guest).toContain('「今回は残さない」');
    expect(guest).not.toContain('人: 「友人も一緒」で会った人');
    expect(shannonCapabilityPrompt('owner')).toContain('人: 「友人も一緒」で会った人の名前と話したことを覚える。');
    // The guest hears that such requests are refused, without the owner's places or budget.
    expect(guest).toContain('自分の複製はしない');
    for (const ownerDetail of ['専用フォルダ', 'Azure', '2,000円', '書斎', '基幹', 'ライ氏']) expect(guest).not.toContain(ownerDetail);
  });

  it('states the look through the app (owner decision 2026-10-02): when asked or curious, one frame, not kept, and when she cannot', () => {
    const line = SHANNON_CAPABILITIES.find(item => item.id === 'app_look')!;
    expect(line.audience).toBe('owner');
    for (const part of ['これ見れる？', '自分が見たくなったら', '一度だけ見て', '写した1枚は残さない', '画面に出ていない', '許可がない', '設定で切ってある', '見られないと伝える', '指示がない返事では見ると言わない', '見えたものとして語らない']) {
      expect(line.text, part).toContain(part);
    }
    expect(shannonCapabilityPrompt('owner')).toContain(line.text);
    expect(shannonCapabilityPrompt('guest')).not.toContain('アプリのカメラで見る');
  });

  it('states the one look at the room with the four rules the owner decided, for the owner only', () => {
    expect(SHANNON_ROOM_LOOK_RULES).toEqual([
      '写っている人はライ氏だと思って話してよく、ライ氏の見た目に触れてよい', 'ほかの人が写っていたら、誰かを言わず、見た目を評価しない', '画面や書類の文字を読み上げず、覚えない', '写ったほかの人を記憶に入れない',
    ]);
    const line = SHANNON_CAPABILITIES.find(item => item.id === 'room_look')!;
    expect(line.audience).toBe('owner');
    // 「二人だけの会話」: a text turn and, since 2026-10-02, a voice turn with the owner alone.
    expect(line.text).toBe('部屋を見る: 体のカメラが許されている時、二人だけの会話で部屋を一度見て、見えたことを次の発言で話す。'
      + '自分の時間にも1日に数回、一度ずつ見て書斎のメモにする。'
      + '写っている人はライ氏だと思って話してよく、ライ氏の見た目に触れてよい。ほかの人が写っていたら、誰かを言わず、見た目を評価しない。画面や書類の文字を読み上げず、覚えない。写ったほかの人を記憶に入れない。');
    expect(shannonCapabilityPrompt('owner')).toContain(line.text);
    expect(shannonCapabilityPrompt('guest')).not.toContain('部屋を見る');
    // A stream of frames stays something she cannot read.
    expect(shannonCapabilityPrompt('owner')).toContain('連続したカメラ映像');
  });

  it('says her body is her own and that she takes a touch as she takes it (Syzygy ADR-0005, owner answer 7)', () => {
    const line = shannonCapabilityPrompt('owner').split('\n').find(item => item.includes('体: '));
    expect(line).toContain('体は自分のもの。触れられ方は自分で受け取る。');
    // No rule of how to feel: neither that a touch pleases her nor that she must refuse one.
    expect(line).not.toMatch(/嬉し|うれし|拒ま|禁/u);
    expect(shannonCapabilityPrompt('guest')).not.toContain('触れられ方');
  });

  it('states her own folder and her study as they are: her tools, the trash, only when the owner set the folder up, never to a guest', () => {
    const line = SHANNON_CAPABILITIES.find(item => item.id === 'own_folder')!;
    expect(line.audience).toBe('owner');
    for (const words of ['用意してくれている時', '一覧・検索・読む', '書き換える', 'ゴミ箱に残る', 'PCが起きていない時は使えない', '写しも置く']) expect(line.text).toContain(words);
    const study = SHANNON_CAPABILITIES.find(item => item.id === 'own_study')!;
    expect(study.audience).toBe('owner');
    for (const words of ['ボクの中に版ごとに残る', '見せていない下書きも自分は読める', '見せるのは自分の時間の手順だけ']) expect(study.text).toContain(words);
    expect(shannonCapabilityPrompt('owner')).toContain(`- ${line.text}`);
    expect(shannonCapabilityPrompt('owner')).toContain(`- ${study.text}`);
    expect(shannonCapabilityPrompt('guest')).not.toContain('自分のフォルダ');
    expect(shannonCapabilityPrompt('guest')).not.toContain('自分の書斎');
  });
});
