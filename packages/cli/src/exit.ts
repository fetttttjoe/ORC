// thrown, not assigned to process.exitCode: a global any test would leave behind
export class CommandFailure extends Error {
  constructor(readonly exitCode: number, message = '') {
    super(message)
    this.name = 'CommandFailure'
  }
}

// shared by the entry point and the subprocess fixture, so CI observes what a user observes
export function exitCodeFor(error: unknown): number | null {
  return error instanceof CommandFailure ? error.exitCode : null
}

// 3: 1 is every other failure, 2 is bash misuse; plugin/hooks/session-start.sh spells it again
export const EXIT_CODE = { failure: 1, noProject: 3 } as const

export const DATABASE_UNREACHABLE = (url: string): string => `Postgres is not reachable at ${url} — start it with: docker compose up -d`

export const NO_PROJECT_ERROR = (message: string): Error => new Error(message)
