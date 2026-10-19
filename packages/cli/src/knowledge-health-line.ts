import { KnowledgeHealthState, type KnowledgeHealth } from '@orc/contracts'

export const knowledgeHealthLine = (h: KnowledgeHealth): string =>
  h.state === KnowledgeHealthState.ok ? `knowledge: ${h.claims} claims · ${h.suspect} suspect` : `knowledge unavailable: ${h.reason}`
