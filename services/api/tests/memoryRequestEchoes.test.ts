import { describe, expect, it } from 'vitest';
import { withoutRequestEchoes, type VisibleMessage } from '../src/mind/memory/memoryVisibility.js';

const line = (role: 'user' | 'assistant', content: string): VisibleMessage => ({ message: {} as VisibleMessage['message'], item: { role, content } as VisibleMessage['item'] });

describe('the replay reads a spoken request once', () => {
  it('leaves out the echo kept under the speaker\'s name, and the reply repeated to it', () => {
    const history = [
      line('user', 'ケーキを作ってほしいな'), line('assistant', 'いいよ、作るね。'),
      line('user', 'ライ（通話）: ケーキを作ってほしいな'), line('assistant', 'いいよ、作るね。'),
      line('user', '次は鉄を取ろう'),
    ];
    expect(withoutRequestEchoes(history).map(entry => entry.item.content)).toEqual(['ケーキを作ってほしいな', 'いいよ、作るね。', '次は鉄を取ろう']);
  });

  it('keeps a line that only looks like one: other words, or no same words just before', () => {
    const different = [line('user', '木を集めて'), line('assistant', 'うん。'), line('user', 'ユウ（通話）: 鉄を取って'), line('assistant', 'わかった。')];
    expect(withoutRequestEchoes(different)).toBe(different);
    const alone = [line('user', 'ユウ（通話）: 鉄を取って')];
    expect(withoutRequestEchoes(alone)).toBe(alone);
  });
});
