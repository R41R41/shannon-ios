import { randomUUID } from 'node:crypto';

/**
 * Which start of the head this is (continue contract 2): a string made once when the process starts. The head puts it in every reply of a poll
 * (`MinecraftControlReply.headBoot`), in the name of its queues (`queueName`) and in each command's `madeIn`; the body takes the last one it had on a connection as
 * the head that is there now, drops what an earlier one left waiting and refuses its commands. A test gives its own to the control and the queue.
 */
const BOOT = `hb-${randomUUID().slice(0, 12)}`;
export const headBoot = (): string => BOOT;
