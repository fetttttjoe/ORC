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
