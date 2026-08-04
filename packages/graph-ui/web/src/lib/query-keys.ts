// The ONE spelling of every query key. The invalidation table and the components that register
// queries must agree exactly, and a silent disagreement shows up as data that never refreshes —
// nothing throws. Builders make the agreement compile-time.
export const qk = {
  task: (taskId: string) => ['task', taskId] as const,
  taskPlans: (taskId: string) => ['task', taskId, 'plans'] as const,
  taskPlanNotes: (taskId: string) => ['task', taskId, 'planNotes'] as const,
  taskTranscript: (taskId: string, stepId: string | null) => ['task', taskId, 'transcript', stepId] as const,
  taskLog: (taskId: string) => ['task', taskId, 'log'] as const,
  node: (nodeId: string) => ['node', nodeId] as const,
  models: (project: string) => ['models', project] as const,
  health: () => ['health'] as const,
} as const
