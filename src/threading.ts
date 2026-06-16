import type { PipMessage } from "./types.js";

export function getEffectiveThreadId(message: Pick<PipMessage, "id" | "threadId" | "invokeThreadId" | "inReplyTo">): string {
  return message.threadId ?? message.invokeThreadId ?? message.inReplyTo ?? message.id;
}
