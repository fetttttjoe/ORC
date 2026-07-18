// runtime-checked narrowing for values from external boundaries (JSON, YAML, wire input)
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
