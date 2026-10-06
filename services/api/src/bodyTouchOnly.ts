import type { BodyCapabilities } from './contracts/bodyContract.js';

/**
 * A body that only feels touch (`docs/body-contract.md`, "A body that only feels touch"): the owner's
 * phone showing her Live2D figure. It registers `flags.touchOnly: true` so that it may ask for a
 * reaction to a touch, and it is nothing else of a body:
 *
 * - it is not counted when a look asks whether a body is connected (the reason stays "no body");
 * - a presence read by it is not "her window is showing", and what it says about its audience is not kept;
 * - it may not report what it did with a message she started on her own;
 * - the audience of its events does not stand in for who can see or hear her body.
 *
 * - a `camera` flag on such a registration is not read: no look at the room is ever given to it;
 * - an ordinary app read of `/v1/initiatives` by it is not "her body's own read" (`docs/private-listening-contract.md`).
 */
export const BODY_TOUCH_ONLY_FLAG = 'touchOnly';

/** A body that shows her (the desktop application): registered, and not touch-only. */
export const isFullBody = (capabilities: Pick<BodyCapabilities, 'flags'> | null | undefined): boolean =>
  capabilities != null && !isTouchOnlyBody(capabilities);

export const isTouchOnlyBody = (capabilities: Pick<BodyCapabilities, 'flags'> | null | undefined): boolean =>
  capabilities?.flags[BODY_TOUCH_ONLY_FLAG] === true;
