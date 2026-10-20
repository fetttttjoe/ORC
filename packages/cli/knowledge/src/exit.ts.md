# packages/cli/src/exit.ts

## Why
- A command that ran but did not succeed throws CommandFailure instead of assigning process.exitCode, because that global is shared by every test in the process, so one test's code would make a suite with zero failures exit 1 depending on file order. {14q1m6ch @packages/cli/src/exit.ts#CommandFailure}
