// zero imports: feedback-open.ts pulls node:crypto in through ./events and ./knowledge

// one (task, topic) pair: a topic is unique per task, not per project
export const feedbackKey = (taskId: string, topic: string): string => `${taskId} ${topic}`
