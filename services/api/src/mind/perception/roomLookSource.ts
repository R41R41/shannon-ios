/**
 * Which of her messages are about what she saw of the room. Such a message stays in the Talk:
 * a notice outside it (an iPhone push, the Mac's own notification) says only that she has
 * something to say about the room. Kept free of imports so the push store and the initiative
 * store can both use it without reaching the body.
 */

/** Mirrors `BODY_LOOK_SOURCE_PREFIX` (`bodyLookDelivery.ts`): her words about one look. */
export const ROOM_LOOK_SOURCE_PREFIX = 'body-look:';
/** Mirrors `REACH_OUT_SOURCE_PREFIX` + `saw` (`reachOutDelivery.ts`): a message of her own about what she saw of the room. */
export const ROOM_SEEN_SOURCE_PREFIX = 'reach-out:saw:';
/** Mirrors `REACH_OUT_FOLLOW_UP_SEEN_SOURCE_PREFIX`: her second call after an unanswered message, worded with her note of a look in front of her. */
export const ROOM_SEEN_FOLLOW_UP_SOURCE_PREFIX = 'reach-out:follow_up:seen:';
/** What a notice outside the Talk says instead of such a message. */
export const ROOM_LOOK_NOTICE_LINE = 'ライ氏、部屋のことでひとことあります。';

export function isRoomLookSource(sourceItemId: unknown): boolean {
  const source = typeof sourceItemId === 'string' ? sourceItemId : '';
  return [ROOM_LOOK_SOURCE_PREFIX, ROOM_SEEN_SOURCE_PREFIX, ROOM_SEEN_FOLLOW_UP_SOURCE_PREFIX].some(prefix => source.startsWith(prefix));
}
