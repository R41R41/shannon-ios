import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { appliedSchemaSteps, schemaStepChecksum } from '../src/infra/sqlite/migrations/schemaSteps.js';
import { VISION_STEPS } from '../src/infra/sqlite/migrations/vision/visionSteps.js';
import { SQLiteVisionBudgetStore } from '../src/mind/vision/store/visionBudgetStore.js';
import { SQLiteVisionChoiceStore } from '../src/mind/vision/store/visionChoiceStore.js';

// A schema step is never edited once it may have been applied: a changed checksum stops every process at boot
// (SHANNON_SCHEMA_STEP_CHANGED). These are the vision worker's steps as first released (Syzygy ADR-0011 stage 1); a change is a new step.
const PINNED: Record<string, string> = {
  'vision/001_vision_budget': 'c66c289949d401fa7724ed9a896bbd728a6c9cfd6e2ca03d8d820c13b599d622',
  'vision/002_vision_choices': '74cb63a1f1d7787aafba63a1903df30d647af194dc4d0967874fb6ce6f3db208',
};

describe('vision schema steps', () => {
  it('keep the checksums they were released with', () => {
    expect(Object.fromEntries(VISION_STEPS.map(step => [step.id, schemaStepChecksum(step)]))).toEqual(PINNED);
  });

  it('are applied once by whichever store opens first, and hold no column for a picture or words', () => {
    const database = new DatabaseSync(':memory:');
    new SQLiteVisionBudgetStore(database);
    new SQLiteVisionChoiceStore(database);
    expect(appliedSchemaSteps(database).filter(step => step.id.startsWith('vision/')).map(step => step.id)).toEqual(Object.keys(PINNED));
    const columns = ['vision_budget_reservations', 'vision_choices'].flatMap(table =>
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
    expect(columns.filter(name => /image|frame|base64|jpeg|text|content|words/u.test(name))).toEqual([]);
  });
});
