// A command that ran to completion but did NOT succeed — a blocked run, a replay with nothing to
// fold. It is a thrown value rather than an assignment to `process.exitCode` because that global is
// writable by anything and observable by everything: actions used to set it directly, so a test
// exercising one of those paths left the code behind in the TEST process, and a suite reporting
// 0 failures exited 1 in CI purely on test-file order. A command states its outcome; the entry
// point is the single place that decides the process's fate.
//
// The message is optional and usually empty: these commands have already printed their own
// human-readable result, and the caller must not print it twice.
export class CommandFailure extends Error {
  constructor(readonly exitCode: number, message = '') {
    super(message)
    this.name = 'CommandFailure'
  }
}

// Translate a thrown command outcome into a process exit code. Shared by the real entry point and
// the subprocess test fixture, so what CI observes is what a user observes.
export function exitCodeFor(error: unknown): number | null {
  return error instanceof CommandFailure ? error.exitCode : null
}

// The process's exit vocabulary. `noProject` exists for callers that run orc in directories they
// did not choose — a session hook installed at user scope fires in every repository — and must tell
// "nothing to say here" from "orc is broken here" without matching on a sentence. 3, because 1 is
// every other failure (commander's usage errors included — an unknown command exits 1, measured),
// 2 is what bash reports for misuse of a builtin, and anything above 125 belongs to the shell.
// plugin/hooks/session-start.sh spells the number again
// (bash cannot import this); claude-plugin.test.ts drives that script with a stub exiting
// EXIT_CODE.noProject, so the two cannot drift silently.
export const EXIT_CODE = { failure: 1, noProject: 3 } as const

export const DATABASE_UNREACHABLE = (url: string): string => `Postgres is not reachable at ${url} — start it with: docker compose up -d`

export const NO_PROJECT_ERROR = (message: string): Error => new Error(message)
