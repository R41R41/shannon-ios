/**
 * The window of the owner's schedule (rule `mind-via-ports`): what her calendar tools take of the memory part. Kept apart from
 * `memoryPorts.ts` so that a process that loads memory without her tools does not load the schedule's reading too.
 */
export { type UpcomingItem, upcomingWhen } from './ownerUpcoming.js';
export { instantLocalText, localParts, localTextInstant } from './scheduleWhen.js';
