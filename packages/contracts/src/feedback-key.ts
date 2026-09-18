// Zero imports on purpose — a leaf module, so a browser bundle can take it directly.
// feedback-open.ts (its only importer besides here) pulls in ./events -> ./memory -> ./claim,
// and claim.ts opens with `import { createHash } from 'node:crypto'`, which a browser build
// cannot resolve. This one function has no such dependency, so it lives on its own.

/**
 * The identity of an open question: one (task, topic) pair, spelled ONCE.
 *
 * A topic is unique per task, not per project — two tasks asking `cwd` are two different questions —
 * so the task id is part of the key. Exported so a consumer can ask about a question it holds in
 * hand (the kernel, which has the `feedback_requested` event and needs to know whether that one is
 * still open) without re-deriving the spelling and drifting from the set it is testing against.
 */
export const feedbackKey = (taskId: string, topic: string): string => `${taskId} ${topic}`
