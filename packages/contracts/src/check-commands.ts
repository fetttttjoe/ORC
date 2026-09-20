import { z } from 'zod'
import { CHECKS_STEP_ID } from './step-ids'

const CheckCommands = z.array(z.string().min(1))

export function checkCommandsOf(instructions: string): string[] | null {
  try {
    const parsed = CheckCommands.safeParse(JSON.parse(instructions))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function displayInstructions(step: { id: string; instructions: string }): string {
  const commands = step.id === CHECKS_STEP_ID ? checkCommandsOf(step.instructions) : null
  return commands === null ? step.instructions : commands.map(c => `$ ${c}`).join('\n')
}
