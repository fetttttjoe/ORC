// Zero imports on purpose — a leaf module, so a browser bundle can take it directly:
// feedback-open.ts pulls in ./events, which reaches node:crypto through ./knowledge.

/**
 * The identity of an open question: one (task, topic) pair, spelled ONCE.
 *
 * A topic is unique per task, not per project — two tasks asking `cwd` are two different questions —
 * so the task id is part of the key. Exported so a consumer can ask about a question it holds in
 * hand (the kernel, which has the `feedback_requested` event and needs to know whether that one is
 * still open) without re-deriving the spelling and drifting from the set it is testing against.
 */
export const feedbackKey = (taskId: string, topic: string): string => `${taskId} ${topic}`
