import { describe, expect, it } from 'vitest';
import { catalogDrift } from '../src/wiring/fcaMinecraftTools.js';

/** mb-arch: the body's list changed between the decision and the call; nothing has gone to the body yet. */
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const dig = { name: 'dig-block-at', description: 'dig', readOnly: false, inputSchema: schema({ x: { type: 'integer' } }, ['x']) };
const call = { name: 'mc.dig-block-at', input: { x: 1 } };

describe('the body catalog changing under a step (mb-arch)', () => {
  it('lets the call go when only its words or limits changed, and says so in one line', () => {
    expect(catalogDrift(call, dig, { ...dig }, 'a', 'a')).toBeNull();
    const drift = catalogDrift(call, dig, { ...dig, description: 'dig (new)' }, 'connection-one', 'connection-two');
    expect(drift).toEqual({ callable: true, line: 'tool=mc.dig-block-at keys=description connection=connection-o->connection-t callable=true' });
  });

  it('lets a changed shape through only when the input still fits it; a vanished tool or a changed kind is a call to make again', () => {
    const wider = { ...dig, inputSchema: schema({ x: { type: 'integer' }, takeEquipment: { type: 'boolean' } }, ['x']) };
    expect(catalogDrift(call, dig, wider, 'a', 'b')?.callable).toBe(true);
    const stricter = { ...dig, inputSchema: schema({ x: { type: 'integer' }, y: { type: 'integer' } }, ['x', 'y']) };
    expect(catalogDrift(call, dig, stricter, 'a', 'b')?.callable).toBe(false);
    expect(catalogDrift(call, dig, { ...dig, readOnly: true }, 'a', 'b')?.callable).toBe(false);
    expect(catalogDrift(call, dig, undefined, 'a', 'b')).toEqual({ callable: false, line: 'tool=mc.dig-block-at keys=missing connection=a->b callable=false' });
  });
});