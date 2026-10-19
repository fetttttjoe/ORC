import { z } from 'zod'

export const ProjectIdentity = z.object({ name: z.string().min(1), dir: z.string().min(1) })
export type ProjectIdentity = z.infer<typeof ProjectIdentity>
