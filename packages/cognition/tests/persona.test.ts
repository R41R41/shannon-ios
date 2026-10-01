import { describe, expect, it } from 'vitest';
import {
  SHANNON_CAPABILITIES,
  SHANNON_CORE_PROMPT,
  SHANNON_LIMITATIONS,
  SHANNON_ONE_LINE_VOICE,
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
    expect(shannonCapabilityPrompt('owner').length).toBeLessThanOrEqual(1_100);
    expect(SHANNON_CORE_PROMPT.length).toBeLessThanOrEqual(2_000);
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
    for (const limit of ['カレンダー', 'メール', 'タイマー', '画像や動画の生成', 'PDF', '承認なしの実行']) {
      expect(prompt).toContain(limit);
    }
  });

  it('gives guests only capabilities that need no owner data', () => {
    const guest = shannonCapabilityPrompt('guest');
    expect(guest).toContain('Web検索');
    expect(guest).toContain('場所探し');
    for (const privateWord of ['Aether:', 'Voyager:', '開発作業', '記憶と約束', '作業提案にする']) {
      expect(guest).not.toContain(privateWord);
    }
    expect(guest).toContain('持ち主の記憶・ノート・タスク・作業は見ないし使わない');
  });
});
