/** lines are 1-based and inclusive */
export interface SymbolSpan { name: string; kind: string; startLine: number; endLine: number; digest: string }
export interface Outline { digest: string; symbols: SymbolSpan[]; partial: boolean }
export interface StructureProvider { outline(source: string, path: string): Promise<Outline | null> }

export const STRUCTURE_LIMITS = { closestNames: 5 } as const
