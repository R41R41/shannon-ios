import { describe, expect, it } from 'vitest';
import { withToolMenu } from '../src/mind/tools/shannonToolMenu.js';
import { offeredTools, providerToolName } from '../src/mind/tools/shannonTools.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';

/** 2026-10-13: 「うん、お願い」 after a weather question, and an event question, found no lookup tool loaded in the owner's call. */
describe('the owner voice turn always loads her lookups', () => {
  const session = (surface: 'voice' | 'text') => ({ definitions: offeredTools(surface, 'owner_alone'), maximumCalls: 4,
    deadline: new TurnDeadline(TEXT_TURN_DEADLINE), call: async () => '{}' });
  const loaded = (surface: 'voice' | 'text', options?: { deferMemoryReads?: boolean }) =>
    withToolMenu(session(surface), [], options).definitions.map(tool => tool.name);

  it('keeps weather.forecast and web.research whatever the menu chose, also under the conversation hint', () => {
    for (const names of [loaded('voice'), loaded('voice', { deferMemoryReads: true })]) {
      expect(names).toContain('weather.forecast');
      expect(names).toContain('web.research');
    }
  });

  it('leaves a text turn as it was', () => {
    expect(loaded('text')).not.toContain('weather.forecast');
    expect(offeredTools('voice', 'owner_alone').map(tool => providerToolName(tool.name))).toContain('web_research');
  });
});
