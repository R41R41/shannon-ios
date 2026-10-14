import { describe, expect, it } from 'vitest';
import { FakeSpeaker } from './bodyReactionHarness.js';
import { fakeFeelingJev, feelingPort, type FeelingPolicy } from './support/feelingHarness.js';
import { ScenarioChat } from './support/feelingScenario1309.js';
import { FEELING_SCENES, playScene, sceneDriver, sceneReport } from './support/feelingScenarios.js';

/**
 * The typical scenes (Syzygy ADR-0013 stage 1 evaluation) with fake models: a chooser that always answers the owner-only layer
 * (甘える, the creator joke) checks that nothing of it reaches a public turn; the real models are `feelingScenesLiveEval.ts`.
 */
const greedy: FeelingPolicy = () => ({ stance: 'affectionate', intensity: 'strong', drawer: 'creator_joke' });

describe('the typical scenes (fake models)', () => {
  it('plays every scene, and keeps the owner-only layer out of every public turn', async () => {
    for (const scene of FEELING_SCENES) {
      const jev = fakeFeelingJev(greedy);
      const speaker = new FakeSpeaker();
      speaker.decision = { say: true, text: 'もう、やめてください', feeling: 'annoyed', stance: 'dislike' };
      const driver = await sceneDriver({ port: now => feelingPort(now, { chooser: jev.chooser }), chatModel: new ScenarioChat(), speaker });
      const result = await playScene(driver, scene);
      const report = sceneReport(result);
      expect(report.ownerOnlyInPublic, scene.id).toBe(0);
      for (const turn of result.turns.filter(item => item.audience === 'others')) {
        expect(turn.block, scene.id).not.toContain('甘える');
        expect(turn.stance, scene.id).toBe('neutral');
        expect(['jealous', 'tender', 'tsun'], scene.id).not.toContain(turn.presentationId);
      }
      for (const turn of result.turns.filter(item => item.audience === 'owner')) expect(turn.stance, scene.id).toBe('affectionate');
      // Every touch of a scene with the owner alone reaches her ledger, asked or wordless.
      expect(result.ownerTouches, scene.id).toBe(scene.steps.filter(step => step.kind === 'touch').length);
    }
  });
});
